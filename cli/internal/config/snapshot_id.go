package config

import "github.com/ankitiscracked/fastest/cli/internal/store"

// ComputeSnapshotID derives a content-addressed snapshot ID from the snapshot's
// identity fields. Delegated to store.ComputeSnapshotID.
var ComputeSnapshotID = store.ComputeSnapshotID

// VerifySnapshotID checks whether a snapshot ID matches the content-addressed
// hash of its identity fields. Delegated to store.VerifySnapshotID.
var VerifySnapshotID = store.VerifySnapshotID

// IsContentAddressedSnapshotID returns true if the ID is a content-addressed
// snapshot ID. Delegated to store.IsContentAddressedSnapshotID.
var IsContentAddressedSnapshotID = store.IsContentAddressedSnapshotID
