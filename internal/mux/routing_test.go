package mux

import (
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"github.com/b-nnett/codex-subscription-router/internal/protocol"
	"github.com/b-nnett/codex-subscription-router/internal/state"
)

func TestIsUsageLimitResponseRecognizesStructuredError(t *testing.T) {
	message := protocol.Message{Error: &protocol.RPCError{
		Code:    -32000,
		Message: "turn failed",
		Data:    json.RawMessage(`{"codexErrorInfo":"usage_limit_exceeded"}`),
	}}
	if !isUsageLimitResponse(message) {
		t.Fatal("expected usage-limit error to be recognized")
	}
}

func TestIsUsageLimitResponseIgnoresUnrelatedError(t *testing.T) {
	message := protocol.Message{Error: &protocol.RPCError{
		Code:    -32000,
		Message: "workspace folder is unavailable",
	}}
	if isUsageLimitResponse(message) {
		t.Fatal("unrelated error was misclassified as a usage limit")
	}
}

func TestIsUsageLimitResponseIgnoresPluginRateLimitAndQuotaText(t *testing.T) {
	for _, message := range []string{
		"Notion connector rate limit reached",
		"Slack workspace quota exceeded",
		"MCP tool returned rate_limit",
	} {
		t.Run(message, func(t *testing.T) {
			response := protocol.Message{Error: &protocol.RPCError{
				Code: -32000, Message: message,
			}}
			if isUsageLimitResponse(response) {
				t.Fatalf("plugin error was misclassified as subscription depletion: %q", message)
			}
		})
	}
}

func TestManualLockedAndPluginThreadsCannotMigrate(t *testing.T) {
	root := t.TempDir()
	store, err := state.Open(filepath.Join(root, "mux"), filepath.Join(root, "primary"))
	if err != nil {
		t.Fatal(err)
	}
	m := &Multiplexer{store: store}
	if err := store.SetThreadRouting("manual", state.ThreadRoutingState{
		Mode: state.RoutingModeManualLocked, AccountID: "primary",
	}); err != nil {
		t.Fatal(err)
	}
	if failure := m.nonMigratableThreadFailure(json.RawMessage(`1`), "manual"); failure == nil || failure.Error == nil || failure.Error.Code != -32030 {
		t.Fatalf("manual lock did not stop migration: %#v", failure)
	}
	if err := store.SetThreadRouting("plugin", state.ThreadRoutingState{
		Mode: state.RoutingModePreferred, AccountID: "primary",
		PluginConnectors: []string{"notion@remote"},
	}); err != nil {
		t.Fatal(err)
	}
	if failure := m.nonMigratableThreadFailure(json.RawMessage(`2`), "plugin"); failure == nil || failure.Error == nil || failure.Error.Code != -32033 {
		t.Fatalf("plugin thread did not stop migration: %#v", failure)
	}
	if failure := m.nonMigratableThreadFailure(json.RawMessage(`3`), "legacy"); failure != nil {
		t.Fatalf("legacy auto thread was unexpectedly locked: %#v", failure)
	}
}

func TestAllSubscriptionsDepletedUsesActionableMessage(t *testing.T) {
	message := allSubscriptionsDepleted(json.RawMessage(`7`), nil)
	if message.Error == nil || message.Error.Code != -32026 {
		t.Fatalf("unexpected error response: %#v", message)
	}
	if message.Error.Message != "All connected subscriptions are depleted. Add another subscription or wait for usage to reset." {
		t.Fatalf("unexpected depletion message: %q", message.Error.Message)
	}
}

func TestAllSubscriptionsDepletedShowsKnownResetTime(t *testing.T) {
	reset := time.Date(2026, time.August, 16, 10, 30, 0, 0, time.Local).Unix()
	message := allSubscriptionsDepleted(json.RawMessage(`7`), &reset)
	if message.Error == nil {
		t.Fatal("expected an error response")
	}
	want := "All connected subscriptions are depleted. Usage resets on Sunday, 16 August at 10:30 AM."
	if message.Error.Message != want {
		t.Fatalf("unexpected reset message: %q", message.Error.Message)
	}
}
