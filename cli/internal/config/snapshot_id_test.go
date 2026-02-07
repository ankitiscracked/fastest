package config

import (
	"testing"
)

func TestComputeSnapshotIDDeterministic(t *testing.T) {
	id1 := ComputeSnapshotID("abc123", []string{"parent1"}, "John", "john@example.com", "2024-01-01T00:00:00Z")
	id2 := ComputeSnapshotID("abc123", []string{"parent1"}, "John", "john@example.com", "2024-01-01T00:00:00Z")
	if id1 != id2 {
		t.Fatalf("expected deterministic IDs, got %s and %s", id1, id2)
	}
}

func TestComputeSnapshotIDFormat(t *testing.T) {
	id := ComputeSnapshotID("abc123", nil, "John", "john@example.com", "2024-01-01T00:00:00Z")
	if len(id) != 64 {
		t.Fatalf("expected 64-char hex ID, got %d chars: %s", len(id), id)
	}
	for _, c := range id {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			t.Fatalf("expected hex chars only, got %q in %s", c, id)
		}
	}
}

func TestComputeSnapshotIDDifferentInputs(t *testing.T) {
	base := ComputeSnapshotID("abc123", []string{"p1"}, "John", "john@example.com", "2024-01-01T00:00:00Z")

	// Different manifest hash
	diff1 := ComputeSnapshotID("xyz789", []string{"p1"}, "John", "john@example.com", "2024-01-01T00:00:00Z")
	if base == diff1 {
		t.Fatalf("different manifest hash should produce different ID")
	}

	// Different parents
	diff2 := ComputeSnapshotID("abc123", []string{"p2"}, "John", "john@example.com", "2024-01-01T00:00:00Z")
	if base == diff2 {
		t.Fatalf("different parents should produce different ID")
	}

	// Different author
	diff3 := ComputeSnapshotID("abc123", []string{"p1"}, "Jane", "jane@example.com", "2024-01-01T00:00:00Z")
	if base == diff3 {
		t.Fatalf("different author should produce different ID")
	}

	// Different timestamp
	diff4 := ComputeSnapshotID("abc123", []string{"p1"}, "John", "john@example.com", "2025-01-01T00:00:00Z")
	if base == diff4 {
		t.Fatalf("different timestamp should produce different ID")
	}

	// No parents vs with parents
	diff5 := ComputeSnapshotID("abc123", nil, "John", "john@example.com", "2024-01-01T00:00:00Z")
	if base == diff5 {
		t.Fatalf("nil parents vs non-nil parents should produce different ID")
	}
}

func TestComputeSnapshotIDSortsParents(t *testing.T) {
	id1 := ComputeSnapshotID("abc", []string{"b", "a", "c"}, "John", "j@e.com", "2024-01-01T00:00:00Z")
	id2 := ComputeSnapshotID("abc", []string{"c", "a", "b"}, "John", "j@e.com", "2024-01-01T00:00:00Z")
	id3 := ComputeSnapshotID("abc", []string{"a", "b", "c"}, "John", "j@e.com", "2024-01-01T00:00:00Z")
	if id1 != id2 || id2 != id3 {
		t.Fatalf("parent order should not matter: %s, %s, %s", id1, id2, id3)
	}
}

func TestComputeSnapshotIDEmptyAuthor(t *testing.T) {
	// Empty author should still produce a valid ID
	id := ComputeSnapshotID("abc", nil, "", "", "2024-01-01T00:00:00Z")
	if len(id) != 64 {
		t.Fatalf("expected 64-char hex ID with empty author, got %d chars", len(id))
	}
	// Empty author should differ from non-empty author
	id2 := ComputeSnapshotID("abc", nil, "John", "j@e.com", "2024-01-01T00:00:00Z")
	if id == id2 {
		t.Fatalf("empty author should produce different ID than non-empty author")
	}
}

func TestVerifySnapshotID(t *testing.T) {
	manifest := "abc123"
	parents := []string{"p1"}
	name := "John"
	email := "john@example.com"
	ts := "2024-01-01T00:00:00Z"

	id := ComputeSnapshotID(manifest, parents, name, email, ts)

	// Correct verification
	if !VerifySnapshotID(id, manifest, parents, name, email, ts) {
		t.Fatalf("expected valid ID to verify")
	}

	// Tampered manifest hash
	if VerifySnapshotID(id, "tampered", parents, name, email, ts) {
		t.Fatalf("expected tampered manifest to fail verification")
	}

	// Tampered parents
	if VerifySnapshotID(id, manifest, []string{"tampered"}, name, email, ts) {
		t.Fatalf("expected tampered parents to fail verification")
	}

	// Tampered author
	if VerifySnapshotID(id, manifest, parents, "Evil", email, ts) {
		t.Fatalf("expected tampered author name to fail verification")
	}

	// Tampered timestamp
	if VerifySnapshotID(id, manifest, parents, name, email, "2099-01-01T00:00:00Z") {
		t.Fatalf("expected tampered timestamp to fail verification")
	}
}

func TestVerifySnapshotIDLegacyPassesAlways(t *testing.T) {
	// Legacy IDs (with snap- prefix) should always pass
	if !VerifySnapshotID("snap-abc123def456", "any", nil, "", "", "") {
		t.Fatalf("legacy ID should always pass verification")
	}
	if !VerifySnapshotID("snap-"+string(make([]byte, 32)), "any", nil, "", "", "") {
		t.Fatalf("legacy ID should always pass verification")
	}
}

func TestIsContentAddressedSnapshotID(t *testing.T) {
	// Content-addressed: 64 hex chars, no prefix
	caID := ComputeSnapshotID("abc", nil, "J", "j@e", "2024-01-01T00:00:00Z")
	if !IsContentAddressedSnapshotID(caID) {
		t.Fatalf("expected content-addressed ID to be detected: %s (len=%d)", caID, len(caID))
	}

	// Legacy: has snap- prefix
	if IsContentAddressedSnapshotID("snap-abc123") {
		t.Fatalf("legacy ID should not be content-addressed")
	}

	// Wrong length
	if IsContentAddressedSnapshotID("abc123") {
		t.Fatalf("short ID should not be content-addressed")
	}

	// snap- prefix with 64 chars after (legacy embedded-hash format)
	if IsContentAddressedSnapshotID("snap-" + caID) {
		t.Fatalf("snap- prefixed 69-char ID should not be content-addressed")
	}
}
