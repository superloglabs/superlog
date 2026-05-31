package main

import (
	"os"
	"strings"
	"testing"
)

func TestCollectorArgsDefaultsToSingleWriteConfig(t *testing.T) {
	got := collectorArgs(nil, "")
	want := []string{"--config=/etc/otelcol-contrib/config.yaml"}

	if len(got) != len(want) || got[0] != want[0] {
		t.Fatalf("collectorArgs() = %#v, want %#v", got, want)
	}
}

func TestCollectorArgsUsesConfiguredPath(t *testing.T) {
	got := collectorArgs(nil, "/etc/otelcol-contrib/config.yaml")
	want := []string{"--config=/etc/otelcol-contrib/config.yaml"}

	if len(got) != len(want) || got[0] != want[0] {
		t.Fatalf("collectorArgs() = %#v, want %#v", got, want)
	}
}

func TestCollectorArgsIgnoresInheritedBaseImageConfig(t *testing.T) {
	got := collectorArgs([]string{"--config", "/etc/otelcol-contrib/config.yaml"}, "/etc/otelcol-contrib/config-dual-clickhouse.yaml")
	want := []string{"--config=/etc/otelcol-contrib/config-dual-clickhouse.yaml"}

	if len(got) != len(want) || got[0] != want[0] {
		t.Fatalf("collectorArgs() = %#v, want %#v", got, want)
	}
}

func TestCollectorArgsPreservesExplicitArgs(t *testing.T) {
	got := collectorArgs([]string{"--version"}, "/etc/otelcol-contrib/config.yaml")
	want := []string{"--version"}

	if len(got) != len(want) || got[0] != want[0] {
		t.Fatalf("collectorArgs() = %#v, want %#v", got, want)
	}
}

func TestCollectorConfigsAllowLargeQueuedPayloads(t *testing.T) {
	for _, path := range []string{"config.yaml", "config-dual-clickhouse.yaml"} {
		t.Run(path, func(t *testing.T) {
			config, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}

			if !strings.Contains(string(config), "max_request_body_size: 536870912") {
				t.Fatalf("%s should allow OTLP/HTTP requests up to 512 MiB", path)
			}
		})
	}
}
