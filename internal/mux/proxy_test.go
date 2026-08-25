package mux

import "testing"

func TestParseMacOSSystemProxies(t *testing.T) {
	proxies := parseMacOSSystemProxies(`
<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7897
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7898
  HTTPSProxy : proxy.example.test
}
`)
	if got := proxies["http"].String(); got != "http://127.0.0.1:7897" {
		t.Fatalf("unexpected HTTP proxy: %q", got)
	}
	if got := proxies["https"].String(); got != "http://proxy.example.test:7898" {
		t.Fatalf("unexpected HTTPS proxy: %q", got)
	}
}

func TestParseMacOSSystemProxiesRejectsDisabledOrInvalidEntries(t *testing.T) {
	proxies := parseMacOSSystemProxies(`
<dictionary> {
  HTTPEnable : 0
  HTTPPort : 7897
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : invalid
  HTTPSProxy : 127.0.0.1
}
`)
	if len(proxies) != 0 {
		t.Fatalf("expected no usable proxies, got %#v", proxies)
	}
}
