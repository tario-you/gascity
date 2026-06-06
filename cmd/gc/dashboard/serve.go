package dashboard

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
)

// Serve starts the dashboard HTTP server. The dashboard is a static
// TypeScript SPA that calls the supervisor's typed OpenAPI endpoints
// directly from the browser. This function embeds + serves the compiled
// bundle and injects `supervisorURL` into the page so the SPA knows where
// to reach the supervisor.
func Serve(port int, supervisorURL string) error {
	supervisorURL = strings.TrimRight(strings.TrimSpace(supervisorURL), "/")
	if supervisorURL == "" {
		return fmt.Errorf("dashboard: supervisor URL is empty; pass --api")
	}

	handler, err := NewStaticHandler(supervisorURL)
	if err != nil {
		return err
	}

	addr := dashboardListenAddr(port)
	log.Printf("dashboard: listening on http://%s (supervisor=%s)", addr, supervisorURL)
	return http.ListenAndServe(addr, logRequest(handler))
}

func dashboardListenAddr(port int) string {
	return net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
}
