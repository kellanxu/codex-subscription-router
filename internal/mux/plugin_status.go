package mux

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	PluginConnectionConnected    = "connected"
	PluginConnectionUnauthorized = "unauthorized"
	PluginConnectionUnknown      = "unknown"
	PluginConnectionConflict     = "conflict"
)

var explicitPluginURI = regexp.MustCompile(`plugin://([^\s)\]}>"'` + "`" + `]+)`)

type PluginConnectionStatus struct {
	ID            string `json:"id"`
	Label         string `json:"label"`
	State         string `json:"state"`
	Enabled       bool   `json:"enabled"`
	Callable      bool   `json:"callable"`
	AuthStatus    string `json:"authStatus,omitempty"`
	ScopeVerified bool   `json:"scopeVerified"`
	Message       string `json:"message"`
}

type PluginStatusSnapshot struct {
	AccountID string                   `json:"accountId"`
	State     string                   `json:"state"`
	Cached    bool                     `json:"cached"`
	FetchedAt int64                    `json:"fetchedAt,omitempty"`
	ExpiresAt int64                    `json:"expiresAt,omitempty"`
	Error     string                   `json:"error,omitempty"`
	Plugins   []PluginConnectionStatus `json:"plugins"`
}

type pluginStatusCacheEntry struct {
	snapshot  PluginStatusSnapshot
	expiresAt time.Time
}

type pluginStatusRefresh struct {
	done     chan struct{}
	snapshot PluginStatusSnapshot
	err      error
}

type pluginStatusFetcher func(context.Context, string) ([]PluginConnectionStatus, error)

func (m *Multiplexer) PluginStatuses(
	ctx context.Context,
	accountID string,
	refresh bool,
) PluginStatusSnapshot {
	now := m.now()
	m.pluginStatusMu.Lock()
	entry, ok := m.pluginStatusCache[accountID]
	if ok && now.Before(entry.expiresAt) {
		snapshot := entry.snapshot
		snapshot.Cached = true
		m.pluginStatusMu.Unlock()
		return snapshot
	}
	m.pluginStatusMu.Unlock()

	if !refresh {
		return PluginStatusSnapshot{
			AccountID: accountID,
			State:     PluginConnectionUnknown,
			Error:     "plugin status cache is cold",
			Plugins:   []PluginConnectionStatus{},
		}
	}

	timeout := m.pluginStatusTimeout
	if timeout <= 0 {
		timeout = 1800 * time.Millisecond
	}
	m.pluginStatusMu.Lock()
	if m.pluginStatusInFlight == nil {
		m.pluginStatusInFlight = make(map[string]*pluginStatusRefresh)
	}
	inFlight := m.pluginStatusInFlight[accountID]
	if inFlight == nil {
		inFlight = &pluginStatusRefresh{done: make(chan struct{})}
		m.pluginStatusInFlight[accountID] = inFlight
		go m.refreshPluginStatuses(accountID, timeout, inFlight)
	}
	m.pluginStatusMu.Unlock()

	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-inFlight.done:
		if inFlight.err == nil {
			return inFlight.snapshot
		}
		return PluginStatusSnapshot{
			AccountID: accountID,
			State:     PluginConnectionUnknown,
			Error:     "plugin connection status is unavailable",
			Plugins:   []PluginConnectionStatus{},
		}
	case <-timer.C:
		message := "plugin connection status is unavailable"
		message = fmt.Sprintf("plugin status check timed out after %s", timeout)
		return PluginStatusSnapshot{
			AccountID: accountID,
			State:     PluginConnectionUnknown,
			Error:     message,
			Plugins:   []PluginConnectionStatus{},
		}
	case <-ctx.Done():
		return PluginStatusSnapshot{
			AccountID: accountID,
			State:     PluginConnectionUnknown,
			Error:     "plugin connection status request was canceled",
			Plugins:   []PluginConnectionStatus{},
		}
	}
}

func (m *Multiplexer) refreshPluginStatuses(
	accountID string,
	callerTimeout time.Duration,
	inFlight *pluginStatusRefresh,
) {
	backgroundTimeout := callerTimeout * 10
	if backgroundTimeout < 2*time.Second {
		backgroundTimeout = 2 * time.Second
	}
	requestCtx, cancel := context.WithTimeout(context.Background(), backgroundTimeout)
	defer cancel()
	plugins, err := m.pluginStatusFetch(requestCtx, accountID)
	if err == nil {
		inFlight.snapshot = m.cachePluginStatusSnapshot(accountID, plugins)
	} else {
		inFlight.err = err
	}
	m.pluginStatusMu.Lock()
	delete(m.pluginStatusInFlight, accountID)
	close(inFlight.done)
	m.pluginStatusMu.Unlock()
}

func (m *Multiplexer) cachePluginStatusSnapshot(
	accountID string,
	plugins []PluginConnectionStatus,
) PluginStatusSnapshot {
	sort.SliceStable(plugins, func(i, j int) bool {
		return strings.ToLower(plugins[i].Label) < strings.ToLower(plugins[j].Label)
	})
	state := PluginConnectionConnected
	for _, plugin := range plugins {
		if plugin.State == PluginConnectionConflict || plugin.State == PluginConnectionUnknown {
			state = plugin.State
			break
		}
		if plugin.State == PluginConnectionUnauthorized && state == PluginConnectionConnected {
			state = PluginConnectionUnauthorized
		}
	}
	fetchedAt := m.now()
	ttl := m.pluginStatusTTL
	if ttl <= 0 {
		ttl = 30 * time.Second
	}
	snapshot := PluginStatusSnapshot{
		AccountID: accountID,
		State:     state,
		FetchedAt: fetchedAt.UnixMilli(),
		ExpiresAt: fetchedAt.Add(ttl).UnixMilli(),
		Plugins:   plugins,
	}
	m.pluginStatusMu.Lock()
	m.pluginStatusCache[accountID] = pluginStatusCacheEntry{
		snapshot: snapshot, expiresAt: fetchedAt.Add(ttl),
	}
	m.pluginStatusMu.Unlock()
	return snapshot
}

func (m *Multiplexer) fetchPluginStatuses(
	ctx context.Context,
	accountID string,
) ([]PluginConnectionStatus, error) {
	account, ok := m.store.Account(accountID)
	if !ok || !account.Enabled {
		return nil, fmt.Errorf("account %q is disabled or unavailable", accountID)
	}
	child, ok := m.child(accountID)
	if !ok {
		return nil, fmt.Errorf("account %q app-server is unavailable", accountID)
	}
	type result struct {
		method   string
		response json.RawMessage
		err      error
	}
	results := make(chan result, 2)
	go func() {
		params := json.RawMessage(`{"forceRefresh":true}`)
		response, err := child.Request(ctx, "app/installed", params)
		results <- result{method: "app/installed", response: response.Result, err: err}
	}()
	go func() {
		params := json.RawMessage(`{"detail":"toolsAndAuthOnly","limit":200}`)
		response, err := child.Request(ctx, "mcpServerStatus/list", params)
		results <- result{method: "mcpServerStatus/list", response: response.Result, err: err}
	}()
	var installedRaw, statusRaw json.RawMessage
	for received := 0; received < 2; received++ {
		select {
		case response := <-results:
			if response.err != nil {
				return nil, fmt.Errorf("%s: %w", response.method, response.err)
			}
			if response.method == "app/installed" {
				installedRaw = response.response
			} else {
				statusRaw = response.response
			}
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return reconcilePluginStatuses(installedRaw, statusRaw)
}

func reconcilePluginStatuses(installedRaw, statusRaw json.RawMessage) ([]PluginConnectionStatus, error) {
	var installed struct {
		Apps []struct {
			ID          string  `json:"id"`
			RuntimeName *string `json:"runtimeName"`
			Enabled     bool    `json:"enabled"`
			Callable    bool    `json:"callable"`
		} `json:"apps"`
	}
	if err := json.Unmarshal(installedRaw, &installed); err != nil {
		return nil, fmt.Errorf("decode installed apps: %w", err)
	}
	var statuses struct {
		Data []struct {
			Name       string  `json:"name"`
			PluginID   *string `json:"pluginId"`
			AuthStatus string  `json:"authStatus"`
		} `json:"data"`
	}
	if err := json.Unmarshal(statusRaw, &statuses); err != nil {
		return nil, fmt.Errorf("decode MCP status: %w", err)
	}
	byPlugin := make(map[string][]string)
	for _, status := range statuses.Data {
		if status.PluginID == nil || strings.TrimSpace(*status.PluginID) == "" {
			continue
		}
		id := strings.ToLower(strings.TrimSpace(*status.PluginID))
		byPlugin[id] = append(byPlugin[id], status.AuthStatus)
	}
	plugins := make([]PluginConnectionStatus, 0, len(installed.Apps))
	for _, app := range installed.Apps {
		id := strings.TrimSpace(app.ID)
		if id == "" {
			continue
		}
		label := pluginLabel(id)
		if app.RuntimeName != nil && strings.TrimSpace(*app.RuntimeName) != "" {
			label = strings.TrimSpace(*app.RuntimeName)
		}
		authValues := byPlugin[strings.ToLower(id)]
		status := PluginConnectionStatus{
			ID: id, Label: label, Enabled: app.Enabled, Callable: app.Callable,
			ScopeVerified: false,
			Message:       "Connection is account-scoped; workspace, page, and channel access are not verified.",
		}
		status.State, status.AuthStatus = reconcilePluginState(app.Enabled, app.Callable, authValues)
		plugins = append(plugins, status)
		delete(byPlugin, strings.ToLower(id))
	}
	for id, authValues := range byPlugin {
		state, auth := reconcilePluginState(false, false, authValues)
		if state == PluginConnectionUnauthorized {
			continue
		}
		plugins = append(plugins, PluginConnectionStatus{
			ID: id, Label: pluginLabel(id), State: PluginConnectionConflict,
			AuthStatus: auth, ScopeVerified: false,
			Message: "Authentication exists without a matching callable installed connector.",
		})
	}
	return plugins, nil
}

func reconcilePluginState(enabled, callable bool, authValues []string) (string, string) {
	auth := ""
	authorized := false
	unauthorized := false
	unknown := false
	for _, value := range authValues {
		if auth != "" && auth != value {
			return PluginConnectionConflict, value
		}
		auth = value
		switch value {
		case "oAuth", "bearerToken", "unsupported":
			authorized = true
		case "notLoggedIn":
			unauthorized = true
		default:
			unknown = true
		}
	}
	if authorized && unauthorized || callable && unauthorized || !callable && authorized {
		return PluginConnectionConflict, auth
	}
	if callable && enabled && !unknown {
		return PluginConnectionConnected, auth
	}
	if unauthorized || !enabled {
		return PluginConnectionUnauthorized, auth
	}
	return PluginConnectionUnknown, auth
}

func explicitPluginConnectors(params json.RawMessage) []string {
	if len(params) == 0 {
		return nil
	}
	var value any
	if json.Unmarshal(params, &value) != nil {
		return nil
	}
	found := make(map[string]string)
	var walk func(any)
	walk = func(current any) {
		switch typed := current.(type) {
		case string:
			for _, match := range explicitPluginURI.FindAllStringSubmatch(typed, -1) {
				id := strings.TrimSpace(match[1])
				if id != "" {
					found[strings.ToLower(id)] = id
				}
			}
		case []any:
			for _, item := range typed {
				walk(item)
			}
		case map[string]any:
			for _, item := range typed {
				walk(item)
			}
		}
	}
	walk(value)
	result := make([]string, 0, len(found))
	for _, id := range found {
		result = append(result, id)
	}
	sort.Strings(result)
	return result
}

func (m *Multiplexer) preflightPluginConnectors(
	ctx context.Context,
	accountID string,
	connectors []string,
) error {
	account, ok := m.store.Account(accountID)
	if !ok || !account.Enabled {
		return errors.New("the task owner is disabled or unavailable; choose another subscription")
	}
	snapshot := m.PluginStatuses(ctx, accountID, true)
	if snapshot.State == PluginConnectionUnknown && len(snapshot.Plugins) == 0 {
		return fmt.Errorf(
			"Plugin authorization could not be confirmed for %s before the model request (%s). Choose Primary or authorize the connector on %s.",
			account.Label,
			snapshot.Error,
			account.Label,
		)
	}
	byID := make(map[string]PluginConnectionStatus, len(snapshot.Plugins))
	for _, plugin := range snapshot.Plugins {
		byID[strings.ToLower(plugin.ID)] = plugin
	}
	for _, connectorID := range connectors {
		plugin, exists := byID[strings.ToLower(connectorID)]
		if !exists || plugin.State == PluginConnectionUnauthorized {
			return fmt.Errorf(
				"%s is not authorized on %s. Choose Primary for a new task or authorize %s on %s before retrying.",
				pluginLabel(connectorID), account.Label, pluginLabel(connectorID), account.Label,
			)
		}
		if plugin.State == PluginConnectionUnknown || plugin.State == PluginConnectionConflict {
			return fmt.Errorf(
				"%s connection state is %s on %s, so the request was blocked before model execution. Choose Primary or resolve authorization on %s.",
				plugin.Label, plugin.State, account.Label, account.Label,
			)
		}
	}
	return nil
}

func pluginLabel(id string) string {
	name := strings.TrimSpace(strings.SplitN(id, "@", 2)[0])
	name = strings.ReplaceAll(name, "-", " ")
	if name == "" {
		return "Selected connector"
	}
	parts := strings.Fields(name)
	for index := range parts {
		parts[index] = strings.ToUpper(parts[index][:1]) + parts[index][1:]
	}
	return strings.Join(parts, " ")
}
