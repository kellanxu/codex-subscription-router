package mux

import (
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

type systemProxyResolver struct {
	once       sync.Once
	httpProxy  *url.URL
	httpsProxy *url.URL
}

func newProfileHTTPClient() *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	resolver := &systemProxyResolver{}
	transport.Proxy = resolver.proxy
	return &http.Client{Timeout: 10 * time.Second, Transport: transport}
}

func (r *systemProxyResolver) proxy(request *http.Request) (*url.URL, error) {
	configured, err := http.ProxyFromEnvironment(request)
	if configured != nil || err != nil {
		return configured, err
	}
	r.once.Do(r.load)
	if request.URL.Scheme == "https" {
		return r.httpsProxy, nil
	}
	return r.httpProxy, nil
}

func (r *systemProxyResolver) load() {
	if runtime.GOOS != "darwin" {
		return
	}
	output, err := exec.Command("/usr/sbin/scutil", "--proxy").Output()
	if err != nil {
		return
	}
	proxies := parseMacOSSystemProxies(string(output))
	r.httpProxy = proxies["http"]
	r.httpsProxy = proxies["https"]
}

func parseMacOSSystemProxies(output string) map[string]*url.URL {
	values := make(map[string]string)
	for _, line := range strings.Split(output, "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), ":")
		if !ok {
			continue
		}
		values[strings.TrimSpace(key)] = strings.TrimSpace(value)
	}
	proxies := make(map[string]*url.URL)
	for _, protocol := range []string{"HTTP", "HTTPS"} {
		if values[protocol+"Enable"] != "1" {
			continue
		}
		host := values[protocol+"Proxy"]
		port, err := strconv.Atoi(values[protocol+"Port"])
		if host == "" || err != nil || port < 1 || port > 65535 {
			continue
		}
		proxies[strings.ToLower(protocol)] = &url.URL{
			Scheme: "http",
			Host:   net.JoinHostPort(host, strconv.Itoa(port)),
		}
	}
	return proxies
}
