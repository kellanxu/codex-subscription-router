package mux

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

func copyRolloutToAccountHome(sourcePath, sourceCodexHome, targetCodexHome string) (string, error) {
	sourceHome, err := filepath.Abs(sourceCodexHome)
	if err != nil {
		return "", fmt.Errorf("resolve source Codex home: %w", err)
	}
	targetHome, err := filepath.Abs(targetCodexHome)
	if err != nil {
		return "", fmt.Errorf("resolve target Codex home: %w", err)
	}
	source, err := filepath.Abs(sourcePath)
	if err != nil {
		return "", fmt.Errorf("resolve source rollout: %w", err)
	}
	relative, err := filepath.Rel(sourceHome, source)
	if err != nil {
		return "", fmt.Errorf("locate source rollout: %w", err)
	}
	if relative == "." || filepath.IsAbs(relative) || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", errors.New("source rollout is outside its Codex home")
	}
	if first, _, _ := strings.Cut(relative, string(filepath.Separator)); first != "sessions" {
		return "", errors.New("source rollout is outside the sessions directory")
	}
	info, err := os.Stat(source)
	if err != nil {
		return "", fmt.Errorf("stat source rollout: %w", err)
	}
	if !info.Mode().IsRegular() {
		return "", errors.New("source rollout is not a regular file")
	}
	targetDirectory := filepath.Join(targetHome, filepath.Dir(relative))
	if err := os.MkdirAll(targetDirectory, 0o700); err != nil {
		return "", fmt.Errorf("create target sessions directory: %w", err)
	}

	input, err := os.Open(source)
	if err != nil {
		return "", fmt.Errorf("open source rollout: %w", err)
	}
	defer input.Close()
	temporary, err := os.CreateTemp(targetDirectory, ".codex-mux-rollout-*")
	if err != nil {
		return "", fmt.Errorf("create target rollout: %w", err)
	}
	temporaryPath := temporary.Name()
	committed := false
	defer func() {
		_ = temporary.Close()
		if !committed {
			_ = os.Remove(temporaryPath)
		}
	}()
	if err := temporary.Chmod(0o600); err != nil {
		return "", fmt.Errorf("secure target rollout: %w", err)
	}
	hasher := sha256.New()
	if _, err := io.Copy(io.MultiWriter(temporary, hasher), input); err != nil {
		return "", fmt.Errorf("copy target rollout: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		return "", fmt.Errorf("sync target rollout: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return "", fmt.Errorf("close target rollout: %w", err)
	}
	digest := hex.EncodeToString(hasher.Sum(nil))
	snapshotDirectory := filepath.Join(targetDirectory, "codex-mux-"+digest)
	if err := os.MkdirAll(snapshotDirectory, 0o700); err != nil {
		return "", fmt.Errorf("create target snapshot directory: %w", err)
	}
	// Keep the standard rollout filename intact. The app-server's fallback
	// discovery recognizes rollout-...-<thread-id>.jsonl names when importing a
	// path that is not yet present in the target account's state database.
	target := filepath.Join(snapshotDirectory, filepath.Base(relative))
	if _, err := os.Stat(target); err == nil {
		existingDigest, hashErr := fileSHA256(target)
		if hashErr != nil {
			return "", fmt.Errorf("hash existing target rollout: %w", hashErr)
		}
		if existingDigest != digest {
			return "", errors.New("content-addressed target rollout has different contents")
		}
		return target, nil
	} else if !os.IsNotExist(err) {
		return "", fmt.Errorf("inspect target rollout: %w", err)
	}
	if err := os.Rename(temporaryPath, target); err != nil {
		return "", fmt.Errorf("install target rollout: %w", err)
	}
	committed = true
	return target, nil
}

func fileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hasher := sha256.New()
	if _, err := io.Copy(hasher, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}
