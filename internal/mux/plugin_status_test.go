package mux

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/b-nnett/codex-subscription-router/internal/state"
)

func TestExplicitPluginConnectorsUsesOnlyPluginURIs(t *testing.T) {
	params := json.RawMessage(`{"input":[{"type":"text","text":"Use Slack if useful"},{"type":"text","text":"[@Notion](plugin://notion@openai-curated-remote)"}]}`)
	connectors := explicitPluginConnectors(params)
	if len(connectors) != 1 || connectors[0] != "notion@openai-curated-remote" {
		t.Fatalf("unexpected explicit connectors: %#v", connectors)
	}
}

func TestReconcilePluginStatusesDistinguishesConnectedUnauthorizedAndConflict(t *testing.T) {
	installed := json.RawMessage(`{"apps":[{"id":"notion@remote","runtimeName":"Notion","enabled":true,"callable":true},{"id":"slack@remote","runtimeName":"Slack","enabled":true,"callable":false},{"id":"drive@remote","runtimeName":"Drive","enabled":true,"callable":true}]}`)
	statuses := json.RawMessage(`{"data":[{"name":"notion","pluginId":"notion@remote","authStatus":"oAuth"},{"name":"slack","pluginId":"slack@remote","authStatus":"notLoggedIn"},{"name":"drive","pluginId":"drive@remote","authStatus":"notLoggedIn"}]}`)
	plugins, err := reconcilePluginStatuses(installed, statuses)
	if err != nil {
		t.Fatal(err)
	}
	byID := make(map[string]string)
	for _, plugin := range plugins {
		byID[plugin.ID] = plugin.State
		if plugin.ScopeVerified {
			t.Fatalf("connector scope was incorrectly marked verified: %#v", plugin)
		}
	}
	if byID["notion@remote"] != PluginConnectionConnected ||
		byID["slack@remote"] != PluginConnectionUnauthorized ||
		byID["drive@remote"] != PluginConnectionConflict {
		t.Fatalf("unexpected reconciled states: %#v", byID)
	}
}

func TestPluginStatusCacheColdThenHit(t *testing.T) {
	now := time.Date(2026, time.August, 26, 10, 0, 0, 0, time.UTC)
	var calls atomic.Int32
	m := &Multiplexer{
		now:                 func() time.Time { return now },
		pluginStatusCache:   make(map[string]pluginStatusCacheEntry),
		pluginStatusTTL:     30 * time.Second,
		pluginStatusTimeout: time.Second,
		pluginStatusFetch: func(context.Context, string) ([]PluginConnectionStatus, error) {
			calls.Add(1)
			return []PluginConnectionStatus{{
				ID: "notion@remote", Label: "Notion", State: PluginConnectionConnected,
			}}, nil
		},
	}
	cold := m.PluginStatuses(context.Background(), "primary", true)
	hit := m.PluginStatuses(context.Background(), "primary", true)
	if cold.Cached || !hit.Cached || calls.Load() != 1 {
		t.Fatalf("unexpected cache behavior: cold=%#v hit=%#v calls=%d", cold, hit, calls.Load())
	}
}

func TestPluginStatusColdCacheCanRemainNetworkFree(t *testing.T) {
	var calls atomic.Int32
	m := &Multiplexer{
		now:               time.Now,
		pluginStatusCache: make(map[string]pluginStatusCacheEntry),
		pluginStatusFetch: func(context.Context, string) ([]PluginConnectionStatus, error) {
			calls.Add(1)
			return nil, nil
		},
	}
	snapshot := m.PluginStatuses(context.Background(), "primary", false)
	if snapshot.State != PluginConnectionUnknown || calls.Load() != 0 {
		t.Fatalf("ordinary task status check performed plugin I/O: %#v calls=%d", snapshot, calls.Load())
	}
}

func TestPluginStatusTimeoutIsHardBound(t *testing.T) {
	m := &Multiplexer{
		now:                 time.Now,
		pluginStatusCache:   make(map[string]pluginStatusCacheEntry),
		pluginStatusTimeout: 25 * time.Millisecond,
		pluginStatusFetch: func(ctx context.Context, _ string) ([]PluginConnectionStatus, error) {
			<-ctx.Done()
			return nil, ctx.Err()
		},
	}
	started := time.Now()
	snapshot := m.PluginStatuses(context.Background(), "primary", true)
	elapsed := time.Since(started)
	if snapshot.State != PluginConnectionUnknown || !strings.Contains(snapshot.Error, "timed out") {
		t.Fatalf("timeout was not represented as unknown: %#v", snapshot)
	}
	if elapsed > 200*time.Millisecond {
		t.Fatalf("plugin status timeout was not hard bounded: %s", elapsed)
	}
}

func TestPluginStatusTimeoutWarmsCacheInBackground(t *testing.T) {
	var calls atomic.Int32
	m := &Multiplexer{
		now:                  time.Now,
		pluginStatusCache:    make(map[string]pluginStatusCacheEntry),
		pluginStatusInFlight: make(map[string]*pluginStatusRefresh),
		pluginStatusTTL:      time.Second,
		pluginStatusTimeout:  10 * time.Millisecond,
		pluginStatusFetch: func(context.Context, string) ([]PluginConnectionStatus, error) {
			calls.Add(1)
			time.Sleep(50 * time.Millisecond)
			return []PluginConnectionStatus{{
				ID: "notion@remote", Label: "Notion", State: PluginConnectionConnected,
			}}, nil
		},
	}
	first := m.PluginStatuses(context.Background(), "primary", true)
	if first.State != PluginConnectionUnknown {
		t.Fatalf("slow cold refresh did not return unknown: %#v", first)
	}
	time.Sleep(80 * time.Millisecond)
	hit := m.PluginStatuses(context.Background(), "primary", true)
	if !hit.Cached || hit.State != PluginConnectionConnected || calls.Load() != 1 {
		t.Fatalf("background refresh did not warm one cache entry: %#v calls=%d", hit, calls.Load())
	}
}

func TestPluginPreflightBlocksUnknownBeforeForwarding(t *testing.T) {
	root := t.TempDir()
	store, err := state.Open(filepath.Join(root, "mux"), filepath.Join(root, "primary"))
	if err != nil {
		t.Fatal(err)
	}
	m := &Multiplexer{
		store:               store,
		now:                 time.Now,
		pluginStatusCache:   make(map[string]pluginStatusCacheEntry),
		pluginStatusTimeout: time.Second,
		pluginStatusFetch: func(context.Context, string) ([]PluginConnectionStatus, error) {
			return nil, errors.New("offline")
		},
	}
	err = m.preflightPluginConnectors(
		context.Background(),
		"primary",
		[]string{"notion@openai-curated-remote"},
	)
	if err == nil || !strings.Contains(err.Error(), "could not be confirmed") {
		t.Fatalf("unknown plugin state was not blocked: %v", err)
	}
}
