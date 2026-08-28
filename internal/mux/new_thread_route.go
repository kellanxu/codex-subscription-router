package mux

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/b-nnett/codex-subscription-router/internal/state"
)

const newThreadRoutingParameter = "codexMuxRouting"

var errManualRouteUnavailable = errors.New("manually selected subscription is unavailable")

type newThreadRoutingRequest struct {
	Mode      string `json:"mode"`
	AccountID string `json:"accountId,omitempty"`
}

func defaultNewThreadRoutingRequest() newThreadRoutingRequest {
	return newThreadRoutingRequest{Mode: state.RoutingModePreferred}
}

// scopedNewThreadRequest extracts the renderer-only routing envelope before a
// thread/start request reaches the official app-server's strict schema.
func scopedNewThreadRequest(params json.RawMessage) (newThreadRoutingRequest, json.RawMessage, error) {
	routing := defaultNewThreadRoutingRequest()
	if len(params) == 0 {
		return routing, params, nil
	}
	var input map[string]json.RawMessage
	if err := json.Unmarshal(params, &input); err != nil {
		return routing, params, nil
	}
	rawRouting, ok := input[newThreadRoutingParameter]
	if !ok {
		return routing, params, nil
	}
	if err := json.Unmarshal(rawRouting, &routing); err != nil {
		return newThreadRoutingRequest{}, params, fmt.Errorf("invalid new-task subscription selection")
	}
	routing.Mode = strings.TrimSpace(routing.Mode)
	routing.AccountID = strings.TrimSpace(routing.AccountID)
	switch routing.Mode {
	case state.RoutingModeAuto, state.RoutingModePreferred:
		if routing.AccountID != "" {
			return newThreadRoutingRequest{}, params, fmt.Errorf("%s routing cannot lock an account", routing.Mode)
		}
	case state.RoutingModeManualLocked:
		if routing.AccountID == "" {
			return newThreadRoutingRequest{}, params, errors.New("manual subscription selection requires an account")
		}
	default:
		return newThreadRoutingRequest{}, params, fmt.Errorf("unsupported new-task routing mode %q", routing.Mode)
	}
	delete(input, newThreadRoutingParameter)
	cleaned, err := json.Marshal(input)
	if err != nil {
		return newThreadRoutingRequest{}, params, fmt.Errorf("remove private routing metadata: %w", err)
	}
	return routing, cleaned, nil
}
