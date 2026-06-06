package api

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

func (sm *SupervisorMux) serveCitySessionAsset(w http.ResponseWriter, r *http.Request) {
	srv := sm.resolveCityServer(r.PathValue("cityName"))
	if srv == nil {
		problemCityNotFound.writeTo(w)
		return
	}
	srv.handleSessionAssetServe(w, r, r.PathValue("id"), r.URL.Query().Get("path"))
}

func (s *Server) handleSessionAssetServe(w http.ResponseWriter, r *http.Request, idRef, rawPath string) {
	store := s.state.CityBeadStore()
	if store == nil {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "no bead store configured")
		return
	}
	sessionID, err := s.resolveSessionIDAllowClosedWithConfig(store, idRef)
	if err != nil {
		writeHumaStatusError(w, humaResolveError(err))
		return
	}

	info, err := s.sessionManager(store).Get(sessionID)
	if err != nil {
		writeHumaStatusError(w, humaSessionManagerError(err))
		return
	}
	path, err := resolveSessionAssetPath(info.WorkDir, rawPath)
	if err != nil {
		writeSessionAssetError(w, err)
		return
	}
	if err := serveSessionAssetFile(w, r, path); err != nil {
		writeSessionAssetError(w, err)
		return
	}
}

func resolveSessionAssetPath(workDir, rawPath string) (string, error) {
	workDir = strings.TrimSpace(workDir)
	if workDir == "" {
		return "", sessionAssetClientError{status: http.StatusNotFound, code: "work_dir_missing", message: "session work_dir is not available"}
	}
	rawPath = strings.TrimSpace(rawPath)
	if rawPath == "" {
		return "", sessionAssetClientError{status: http.StatusBadRequest, code: "path_required", message: "path query parameter is required"}
	}
	if strings.ContainsRune(rawPath, 0) || strings.HasPrefix(strings.ToLower(rawPath), "file://") {
		return "", sessionAssetClientError{status: http.StatusBadRequest, code: "invalid_path", message: "invalid asset path"}
	}

	workDirAbs, err := filepath.Abs(workDir)
	if err != nil {
		return "", sessionAssetClientError{status: http.StatusBadRequest, code: "invalid_work_dir", message: "invalid session work_dir"}
	}
	workDirEval, err := filepath.EvalSymlinks(workDirAbs)
	if err != nil {
		return "", sessionAssetClientError{status: http.StatusNotFound, code: "work_dir_missing", message: "session work_dir is not available"}
	}
	workDirInfo, err := os.Stat(workDirEval)
	if err != nil || !workDirInfo.IsDir() {
		return "", sessionAssetClientError{status: http.StatusNotFound, code: "work_dir_missing", message: "session work_dir is not available"}
	}

	target := rawPath
	if !filepath.IsAbs(target) {
		target = filepath.Join(workDirAbs, target)
	}
	targetAbs, err := filepath.Abs(filepath.Clean(target))
	if err != nil {
		return "", sessionAssetClientError{status: http.StatusBadRequest, code: "invalid_path", message: "invalid asset path"}
	}
	if !pathWithinDir(workDirAbs, targetAbs) && !pathWithinDir(workDirEval, targetAbs) {
		return "", sessionAssetClientError{status: http.StatusForbidden, code: "path_forbidden", message: "asset path must stay inside session work_dir"}
	}

	targetEval, err := filepath.EvalSymlinks(targetAbs)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", sessionAssetClientError{status: http.StatusNotFound, code: "not_found", message: "asset not found"}
		}
		return "", err
	}
	if !pathWithinDir(workDirEval, targetEval) {
		return "", sessionAssetClientError{status: http.StatusForbidden, code: "path_forbidden", message: "asset path must stay inside session work_dir"}
	}
	return targetEval, nil
}

func serveSessionAssetFile(w http.ResponseWriter, r *http.Request, path string) error {
	data, modTime, err := readSessionAssetFile(path)
	if err != nil {
		return err
	}

	mimeType := strings.ToLower(http.DetectContentType(data[:min(len(data), 512)]))
	if !isAllowedImageMime(mimeType) {
		return sessionAssetClientError{status: http.StatusUnsupportedMediaType, code: "unsupported_media_type", message: "only image assets are supported"}
	}
	w.Header().Set("Content-Type", mimeType)
	w.Header().Set("Content-Disposition", "inline; filename="+strconvQuote(filepath.Base(path)))
	http.ServeContent(w, r, filepath.Base(path), modTime, bytes.NewReader(data))
	return nil
}

func readSessionAssetFile(path string) ([]byte, time.Time, error) {
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, time.Time{}, sessionAssetOpenError(path, err)
	}
	file := os.NewFile(uintptr(fd), path)
	if file == nil {
		_ = unix.Close(fd)
		return nil, time.Time{}, &os.PathError{Op: "open", Path: path, Err: os.ErrInvalid}
	}
	defer func() { _ = file.Close() }()

	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		return nil, time.Time{}, &os.PathError{Op: "stat", Path: path, Err: err}
	}
	if stat.Mode&unix.S_IFMT != unix.S_IFREG {
		return nil, time.Time{}, sessionAssetClientError{status: http.StatusNotFound, code: "not_found", message: "asset not found"}
	}
	if stat.Size > sessionAttachmentMaxBytes {
		return nil, time.Time{}, sessionAssetClientError{status: http.StatusRequestEntityTooLarge, code: "too_large", message: fmt.Sprintf("image assets are limited to %d MB", sessionAttachmentMaxBytes>>20)}
	}

	data, err := io.ReadAll(io.LimitReader(file, sessionAttachmentMaxBytes+1))
	if err != nil {
		return nil, time.Time{}, &os.PathError{Op: "read", Path: path, Err: err}
	}
	if int64(len(data)) > sessionAttachmentMaxBytes {
		return nil, time.Time{}, sessionAssetClientError{status: http.StatusRequestEntityTooLarge, code: "too_large", message: fmt.Sprintf("image assets are limited to %d MB", sessionAttachmentMaxBytes>>20)}
	}

	info, err := file.Stat()
	if err != nil {
		return nil, time.Time{}, &os.PathError{Op: "stat", Path: path, Err: err}
	}
	return data, info.ModTime(), nil
}

func sessionAssetOpenError(path string, err error) error {
	wrapped := &os.PathError{Op: "open", Path: path, Err: err}
	switch {
	case errors.Is(wrapped, os.ErrNotExist):
		return sessionAssetClientError{status: http.StatusNotFound, code: "not_found", message: "asset not found"}
	case errors.Is(wrapped, os.ErrPermission):
		return sessionAssetClientError{status: http.StatusForbidden, code: "forbidden", message: "asset is not readable"}
	case errors.Is(wrapped, unix.ELOOP):
		return sessionAssetClientError{status: http.StatusForbidden, code: "path_forbidden", message: "asset path must stay inside session work_dir"}
	default:
		return wrapped
	}
}

func pathWithinDir(root, candidate string) bool {
	rel, err := filepath.Rel(root, candidate)
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel))
}

type sessionAssetClientError struct {
	status  int
	code    string
	message string
}

func (e sessionAssetClientError) Error() string {
	return e.message
}

func writeSessionAssetError(w http.ResponseWriter, err error) {
	var clientErr sessionAssetClientError
	if errors.As(err, &clientErr) {
		writeError(w, clientErr.status, clientErr.code, clientErr.message)
		return
	}
	writeError(w, http.StatusInternalServerError, "internal", err.Error())
}
