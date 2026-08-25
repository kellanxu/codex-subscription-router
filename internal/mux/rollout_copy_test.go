package mux

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCopyRolloutToAccountHome(t *testing.T) {
	sourceHome := t.TempDir()
	targetHome := t.TempDir()
	source := filepath.Join(sourceHome, "sessions", "2026", "08", "25", "rollout.jsonl")
	if err := os.MkdirAll(filepath.Dir(source), 0o700); err != nil {
		t.Fatal(err)
	}
	contents := []byte("{\"type\":\"session_meta\"}\n")
	if err := os.WriteFile(source, contents, 0o600); err != nil {
		t.Fatal(err)
	}

	target, err := copyRolloutToAccountHome(source, sourceHome, targetHome)
	if err != nil {
		t.Fatal(err)
	}
	wantDirectory := filepath.Join(targetHome, "sessions", "2026", "08", "25")
	if filepath.Dir(filepath.Dir(target)) != wantDirectory ||
		!strings.HasPrefix(filepath.Base(filepath.Dir(target)), "codex-mux-") ||
		filepath.Base(target) != filepath.Base(source) {
		t.Fatalf("unexpected target path: %q", target)
	}
	copied, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(copied) != string(contents) {
		t.Fatalf("unexpected copied contents: %q", copied)
	}
	info, err := os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("unexpected target permissions: %o", info.Mode().Perm())
	}
	if reused, err := copyRolloutToAccountHome(source, sourceHome, targetHome); err != nil || reused != target {
		t.Fatalf("identical target was not reused: path=%q err=%v", reused, err)
	}
}

func TestCopyRolloutCreatesNewSnapshotWhenContentsChange(t *testing.T) {
	sourceHome := t.TempDir()
	targetHome := t.TempDir()
	source := filepath.Join(sourceHome, "sessions", "rollout.jsonl")
	if err := os.MkdirAll(filepath.Dir(source), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, []byte("source"), 0o600); err != nil {
		t.Fatal(err)
	}
	first, err := copyRolloutToAccountHome(source, sourceHome, targetHome)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, []byte("different"), 0o600); err != nil {
		t.Fatal(err)
	}
	second, err := copyRolloutToAccountHome(source, sourceHome, targetHome)
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("changed rollout reused the old snapshot path")
	}
}

func TestCopyRolloutRejectsPathOutsideSessions(t *testing.T) {
	sourceHome := t.TempDir()
	targetHome := t.TempDir()
	source := filepath.Join(sourceHome, "config.toml")
	if err := os.WriteFile(source, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := copyRolloutToAccountHome(source, sourceHome, targetHome); err == nil {
		t.Fatal("expected non-session path to fail")
	}
}
