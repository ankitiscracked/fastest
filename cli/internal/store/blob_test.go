package store

import (
	"testing"
)

func TestWriteReadBlob(t *testing.T) {
	s, _ := setupStore(t)

	content := []byte("hello world")
	if err := s.WriteBlob("hash1", content); err != nil {
		t.Fatalf("WriteBlob: %v", err)
	}

	data, err := s.ReadBlob("hash1")
	if err != nil {
		t.Fatalf("ReadBlob: %v", err)
	}
	if string(data) != "hello world" {
		t.Fatalf("content mismatch: %s", string(data))
	}
}

func TestWriteBlobIdempotent(t *testing.T) {
	s, _ := setupStore(t)

	s.WriteBlob("hash2", []byte("first"))
	// Write again with different content — should not overwrite (content-addressed)
	s.WriteBlob("hash2", []byte("second"))

	data, _ := s.ReadBlob("hash2")
	if string(data) != "first" {
		t.Fatalf("expected first write to persist, got: %s", string(data))
	}
}

func TestBlobExists(t *testing.T) {
	s, _ := setupStore(t)

	if s.BlobExists("nope") {
		t.Fatalf("expected false for missing blob")
	}

	s.WriteBlob("exists", []byte("x"))
	if !s.BlobExists("exists") {
		t.Fatalf("expected true for existing blob")
	}
}

func TestBlobPath(t *testing.T) {
	s, _ := setupStore(t)
	path := s.BlobPath("somehash")
	if path == "" {
		t.Fatalf("expected non-empty path")
	}
}

func TestReadBlobNotFound(t *testing.T) {
	s, _ := setupStore(t)
	_, err := s.ReadBlob("missing")
	if err == nil {
		t.Fatalf("expected error for missing blob")
	}
}

func TestReadBlobEmptyHash(t *testing.T) {
	s, _ := setupStore(t)
	_, err := s.ReadBlob("")
	if err == nil {
		t.Fatalf("expected error for empty hash")
	}
}
