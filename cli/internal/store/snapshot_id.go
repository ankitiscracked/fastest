package store

import (
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strings"
)

// ComputeSnapshotID derives a content-addressed snapshot ID from the snapshot's
// identity fields. The result is deterministic: same inputs always produce the
// same ID. Format: 64-char lowercase hex SHA-256 hash.
func ComputeSnapshotID(manifestHash string, parentSnapshotIDs []string, authorName, authorEmail, createdAt string) string {
	sorted := make([]string, len(parentSnapshotIDs))
	copy(sorted, parentSnapshotIDs)
	sort.Strings(sorted)

	var b strings.Builder
	b.WriteString("snapshot\x00")
	b.WriteString("manifest_hash " + manifestHash + "\n")
	for _, p := range sorted {
		b.WriteString("parent " + p + "\n")
	}
	b.WriteString("author " + authorName + " " + authorEmail + "\n")
	b.WriteString("created_at " + createdAt + "\n")

	hash := sha256.Sum256([]byte(b.String()))
	return hex.EncodeToString(hash[:])
}

// VerifySnapshotID checks whether a snapshot ID matches the content-addressed
// hash of its identity fields. Legacy IDs (with "snap-" prefix) always pass.
func VerifySnapshotID(id, manifestHash string, parentSnapshotIDs []string, authorName, authorEmail, createdAt string) bool {
	if !IsContentAddressedSnapshotID(id) {
		return true
	}
	expected := ComputeSnapshotID(manifestHash, parentSnapshotIDs, authorName, authorEmail, createdAt)
	return id == expected
}

// IsContentAddressedSnapshotID returns true if the ID is a content-addressed
// snapshot ID (64-char hex) rather than a legacy random ID (has "snap-" prefix).
func IsContentAddressedSnapshotID(id string) bool {
	return len(id) == 64 && !strings.HasPrefix(id, "snap-")
}
