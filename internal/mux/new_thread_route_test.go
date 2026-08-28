package mux

import (
	"encoding/json"
	"testing"

	"github.com/b-nnett/codex-subscription-router/internal/state"
)

func TestScopedNewThreadRequestStripsManualRoutingEnvelope(t *testing.T) {
	routing, cleaned, err := scopedNewThreadRequest(json.RawMessage(
		`{"cwd":"/tmp/project","codexMuxRouting":{"mode":"manual_locked","accountId":"pro20"}}`,
	))
	if err != nil {
		t.Fatal(err)
	}
	if routing.Mode != state.RoutingModeManualLocked || routing.AccountID != "pro20" {
		t.Fatalf("unexpected routing request: %#v", routing)
	}
	if string(cleaned) != `{"cwd":"/tmp/project"}` {
		t.Fatalf("private routing marker reached strict params: %s", cleaned)
	}
}

func TestScopedNewThreadRequestDefaultsToPreferredWithoutMutation(t *testing.T) {
	params := json.RawMessage(`{"cwd":"/tmp/project"}`)
	routing, cleaned, err := scopedNewThreadRequest(params)
	if err != nil {
		t.Fatal(err)
	}
	if routing.Mode != state.RoutingModePreferred {
		t.Fatalf("unexpected default mode: %#v", routing)
	}
	if string(cleaned) != string(params) {
		t.Fatalf("unmarked params changed: %s", cleaned)
	}
}

func TestScopedNewThreadRequestRejectsInvalidManualSelection(t *testing.T) {
	_, _, err := scopedNewThreadRequest(json.RawMessage(
		`{"codexMuxRouting":{"mode":"manual_locked"}}`,
	))
	if err == nil {
		t.Fatal("manual routing without an account was accepted")
	}
}
