package store

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

	tests := []struct {
		name string
		id   string
	}{
		{"different manifest", ComputeSnapshotID("xyz789", []string{"p1"}, "John", "john@example.com", "2024-01-01T00:00:00Z")},
		{"different parents", ComputeSnapshotID("abc123", []string{"p2"}, "John", "john@example.com", "2024-01-01T00:00:00Z")},
		{"different author", ComputeSnapshotID("abc123", []string{"p1"}, "Jane", "jane@example.com", "2024-01-01T00:00:00Z")},
		{"different timestamp", ComputeSnapshotID("abc123", []string{"p1"}, "John", "john@example.com", "2025-01-01T00:00:00Z")},
		{"nil parents", ComputeSnapshotID("abc123", nil, "John", "john@example.com", "2024-01-01T00:00:00Z")},
	}

	for _, tt := range tests {
		if base == tt.id {
			t.Fatalf("%s should produce different ID", tt.name)
		}
	}
}

func TestComputeSnapshotIDSortsParents(t *testing.T) {
	id1 := ComputeSnapshotID("abc", []string{"b", "a", "c"}, "J", "j@e.com", "2024-01-01T00:00:00Z")
	id2 := ComputeSnapshotID("abc", []string{"c", "a", "b"}, "J", "j@e.com", "2024-01-01T00:00:00Z")
	id3 := ComputeSnapshotID("abc", []string{"a", "b", "c"}, "J", "j@e.com", "2024-01-01T00:00:00Z")
	if id1 != id2 || id2 != id3 {
		t.Fatalf("parent order should not matter: %s, %s, %s", id1, id2, id3)
	}
}

func TestVerifySnapshotID(t *testing.T) {
	mhash := "abc123"
	parents := []string{"p1"}
	name := "John"
	email := "john@example.com"
	ts := "2024-01-01T00:00:00Z"

	id := ComputeSnapshotID(mhash, parents, name, email, ts)

	if !VerifySnapshotID(id, mhash, parents, name, email, ts) {
		t.Fatalf("expected valid ID to verify")
	}
	if VerifySnapshotID(id, "tampered", parents, name, email, ts) {
		t.Fatalf("expected tampered manifest to fail")
	}
	if VerifySnapshotID(id, mhash, []string{"tampered"}, name, email, ts) {
		t.Fatalf("expected tampered parents to fail")
	}
	if VerifySnapshotID(id, mhash, parents, "Evil", email, ts) {
		t.Fatalf("expected tampered author to fail")
	}
	if VerifySnapshotID(id, mhash, parents, name, email, "2099-01-01T00:00:00Z") {
		t.Fatalf("expected tampered timestamp to fail")
	}
}

func TestVerifySnapshotIDLegacy(t *testing.T) {
	if !VerifySnapshotID("snap-abc123def456", "any", nil, "", "", "") {
		t.Fatalf("legacy ID should always pass")
	}
}

func TestIsContentAddressedSnapshotID(t *testing.T) {
	caID := ComputeSnapshotID("abc", nil, "J", "j@e", "2024-01-01T00:00:00Z")
	if !IsContentAddressedSnapshotID(caID) {
		t.Fatalf("expected content-addressed: %s", caID)
	}
	if IsContentAddressedSnapshotID("snap-abc123") {
		t.Fatalf("legacy should not be content-addressed")
	}
	if IsContentAddressedSnapshotID("abc123") {
		t.Fatalf("short should not be content-addressed")
	}
}
