class_name DwAgentClient
extends Node
## Godot 4 HTTP operations and replayable WebSocket subscriptions.
## Add to the tree before connect_executor(). Tokens are never saved or put in URLs.
## HTTP responses are asynchronous; correlate them using the returned request ID.

signal http_completed(request_id: String, status: int, resource: Variant)
signal http_failed(request_id: String, status: int, error: Dictionary)
signal event_received(event: Dictionary)
signal reply_segment(session: String, run: String, segment: Dictionary)
signal subscription_changed(stream_id: String, subscribed: bool)
signal session_deleted(deleted_id: String)
signal replay_reset_required(stream_id: String, details: Dictionary)
signal transport_ready()
signal protocol_error(message: String)

@export var base_url := "http://127.0.0.1:17850"
@export var state_path := "user://dw_agent_transport_v1.json"
@export_range(1, 16) var max_http_requests := 4
@export_range(1.0, 300.0) var http_timeout_seconds := 30.0

var session_id := ""
var _client_id := ""
var _token := ""
var _principal_id := ""
var _authenticated := false
var _auth_request_id := ""
var _pending: Dictionary = {}
var _active: Dictionary = {}
var _subscriptions: Dictionary = {}
var _blocked_streams: Dictionary = {}
var _commands: Dictionary = {}
var _socket := WebSocketPeer.new()
var _hello_sent := false
var _ws_ready := false
var _retry_delay_ms := 500
var _next_retry_at := 0
var _state_valid := true


func _ready() -> void:
	_client_id = "godot-" + _new_id()
	if not FileAccess.file_exists(state_path):
		_save_state()
		return
	var saved: Variant = JSON.parse_string(FileAccess.get_file_as_string(state_path))
	if not (saved is Dictionary) or saved.get("version") != 1 or saved.get("base_url") != base_url.trim_suffix("/"):
		_state_valid = false
		protocol_error.emit("Transport state is invalid or belongs to another server. Choose a different state_path; do not replay it against a different server.")
		return
	_client_id = str(saved.get("client_id", _client_id))
	_principal_id = str(saved.get("principal_id", ""))
	session_id = str(saved.get("session_id", ""))
	_pending = saved.get("pending", {})
	_subscriptions = saved.get("subscriptions", {})
	_blocked_streams = saved.get("blocked_streams", {})
	if not _pending.is_empty() and _principal_id.is_empty():
		_state_valid = false
		protocol_error.emit("Pending requests have no authenticated owner. Resolve them before choosing a new state_path.")
		return
	for request_id in _pending:
		_pending[request_id]["next_attempt_at"] = 0


func connect_executor(private_token: String) -> void:
	if not _state_valid or not is_inside_tree():
		protocol_error.emit("Add this client to the tree and load valid state before connecting.")
		return
	var address := base_url.trim_suffix("/")
	if not (address.begins_with("http://") or address.begins_with("https://")) or "?" in address or "#" in address or "@" in address:
		protocol_error.emit("base_url must be an HTTP(S) server origin without credentials, query, or fragment.")
		return
	disconnect_executor()
	_token = private_token
	_socket.close()
	_socket = WebSocketPeer.new()
	_ws_ready = false
	_hello_sent = false
	_commands.clear()
	_next_retry_at = 0
	_retry_delay_ms = 500
	_auth_request_id = request("GET", "/api/bootstrap")


func disconnect_executor() -> void:
	_token = ""
	_authenticated = false
	_pending.erase(_auth_request_id)
	_auth_request_id = ""
	for request_id in _active.keys():
		var http: HTTPRequest = _active[request_id]
		http.cancel_request()
		_release_http(request_id)
	_ws_ready = false
	_socket.close()
	# Disconnecting a client does not cancel a server run, task, or job.


func create_session(persona_id: String, user_id: String, workspace_id: String, execution_profile_id: String, model_profile_id: String, title := "") -> String:
	var body := {"persona_id": persona_id, "user_id": user_id,
		"workspace_id": workspace_id, "execution_profile_id": execution_profile_id,
		"model_profile_id": model_profile_id}
	if not title.is_empty():
		body["title"] = title
	return request("POST", "/api/sessions", body)


func select_session(id: String) -> void:
	session_id = id
	if not id.is_empty():
		subscribe("session:" + id)
	_save_state()


func list_sessions(cursor := "", limit := 50) -> String:
	return request("GET", _page("/api/sessions", cursor, limit))


func get_session(id: String) -> String:
	return request("GET", "/api/sessions/" + id.uri_encode(), {}, id)


func delete_session(id: String, expected_revision: int) -> String:
	return request("DELETE", "/api/sessions/%s?expected_revision=%d" % [id.uri_encode(), expected_revision], {}, id)


func submit(text: String) -> String:
	return request("POST", "/api/sessions/%s/messages" % session_id.uri_encode(), {"text": text}, session_id)


func get_history(cursor := "", limit := 50) -> String:
	return request("GET", _page("/api/sessions/%s/messages" % session_id.uri_encode(), cursor, limit), {}, session_id)


func cancel_run(run_id: String) -> String:
	return request("POST", "/api/runs/%s/cancel" % run_id.uri_encode(), {}, session_id)


func create_task(input: String, options: Dictionary = {}) -> String:
	var body := options.duplicate(true)
	body["input"] = input
	return request("POST", "/api/sessions/%s/tasks" % session_id.uri_encode(), body, session_id)


func task_action(task_id: String, action: String) -> String:
	if action not in ["pause", "resume", "cancel"]:
		protocol_error.emit("Task action must be pause, resume, or cancel.")
		return ""
	return request("POST", "/api/tasks/%s/%s" % [task_id.uri_encode(), action], {}, session_id)


func decide_approval(approval_id: String, decision: Dictionary) -> String:
	return request("POST", "/api/approvals/%s/decision" % approval_id.uri_encode(), decision, session_id)


func put_scene(scene: Dictionary) -> String:
	return request("PUT", "/api/sessions/%s/scene-context" % session_id.uri_encode(), scene, session_id)


func report_presentation(presentation: Dictionary) -> String:
	return request("POST", "/api/sessions/%s/presentation-events" % session_id.uri_encode(), presentation, session_id)


func subscribe_companion(persona_id: String, user_id: String) -> void:
	subscribe("companion:%s:%s" % [persona_id, user_id])


func subscribe(stream_id: String, after_seq := 0) -> void:
	if _subscriptions.has(stream_id):
		return # Never rewind an existing durable cursor implicitly.
	_subscriptions[stream_id] = after_seq
	_save_state()
	if _ws_ready:
		_subscribe_wire(stream_id)


func unsubscribe(stream_id: String) -> void:
	_subscriptions.erase(stream_id)
	_blocked_streams.erase(stream_id)
	_save_state()
	if _ws_ready:
		_ws_command("unsubscribe", {"stream_id": stream_id})


## Call only after applying a fresh canonical snapshot for replay_reset_required.
## Session/companion snapshots are fetched automatically; system snapshots are app-owned.
func resume_subscription_after_snapshot(stream_id: String) -> void:
	if not _blocked_streams.has(stream_id) or not _subscriptions.has(stream_id):
		return
	var details: Dictionary = _blocked_streams[stream_id]
	_subscriptions[stream_id] = int(details.get("earliest_seq", 1)) - 1
	_blocked_streams.erase(stream_id)
	_save_state()
	if _ws_ready:
		_subscribe_wire(stream_id)


## Generic transport for all documented HTTP operations, including configuration.
## Session/run/task/approval mutations are persisted before sending and bound to
## the authenticated principal. Configuration requests stay in memory because
## they can contain provider/MCP secrets. Never share state_path across accounts.
## Retry a pending mutation with retry_request(), never by making a new request().
func request(method: String, path: String, body: Dictionary = {}, owner_session_id := "") -> String:
	method = method.to_upper()
	if not _state_valid or not is_inside_tree() or not path.begins_with("/api/") or "#" in path:
		protocol_error.emit("HTTP requests require valid transport state and an /api/ path.")
		return ""
	if method not in ["GET", "POST", "PUT", "PATCH", "DELETE"]:
		protocol_error.emit("Unsupported HTTP method.")
		return ""
	var request_id := _new_id()
	var payload := body.duplicate(true)
	var resource := path.split("?")[0].get_slice("/", 2)
	_pending[request_id] = {"method": method, "path": path,
		"body": "" if method in ["GET", "DELETE"] else JSON.stringify(payload),
		"idempotency_key": "" if method == "GET" else _new_id(),
		"session_id": owner_session_id, "next_attempt_at": 0, "retry_ms": 500,
		"persist": method != "GET" and resource in ["sessions", "runs", "tasks", "approvals"]}
	_save_state()
	return request_id


func retry_request(request_id: String) -> void:
	if _pending.has(request_id) and not _active.has(request_id):
		_pending[request_id]["next_attempt_at"] = 0


func pending_requests() -> Dictionary:
	return _pending.duplicate(true)


func _process(_delta: float) -> void:
	if _token.is_empty() or not _state_valid:
		return
	_pump_http()
	if not _authenticated:
		return
	_socket.poll()
	match _socket.get_ready_state():
		WebSocketPeer.STATE_CLOSED:
			if _socket.get_close_code() == 4001:
				disconnect_executor()
				protocol_error.emit("Authorization expired or was revoked; provide corrected credentials.")
				return
			_ws_ready = false
			_hello_sent = false
			_commands.clear()
			if Time.get_ticks_msec() >= _next_retry_at:
				_socket = WebSocketPeer.new()
				_socket.inbound_buffer_size = 2 * 1024 * 1024
				var ws_url := base_url.trim_suffix("/").replace("https://", "wss://").replace("http://", "ws://") + "/dw-agent/v1"
				var err := _socket.connect_to_url(ws_url)
				_next_retry_at = Time.get_ticks_msec() + _retry_delay_ms
				_retry_delay_ms = mini(_retry_delay_ms * 2, 10000)
				if err != OK:
					protocol_error.emit("WebSocket connection failed: %s" % error_string(err))
		WebSocketPeer.STATE_OPEN:
			if not _hello_sent:
				_hello_sent = true
				_ws_command("hello", {"client_id": _client_id, "token": _token, "versions": [1]})
			while _socket.get_available_packet_count() > 0:
				var packet := _socket.get_packet()
				if not _socket.was_string_packet():
					protocol_error.emit("Unexpected binary WebSocket packet.")
					continue
				var parsed: Variant = JSON.parse_string(packet.get_string_from_utf8())
				if parsed is Dictionary:
					_receive(parsed)
				else:
					protocol_error.emit("Invalid WebSocket JSON.")


func _pump_http() -> void:
	for request_id in _pending.keys():
		if _active.size() >= max_http_requests:
			break
		if _active.has(request_id):
			continue
		if not _authenticated and request_id != _auth_request_id:
			continue
		var entry: Dictionary = _pending[request_id]
		if Time.get_ticks_msec() < int(entry.get("next_attempt_at", 0)):
			continue
		var http := HTTPRequest.new()
		http.timeout = http_timeout_seconds
		add_child(http)
		_active[request_id] = http
		http.request_completed.connect(_http_done.bind(request_id))
		var headers := PackedStringArray(["Authorization: Bearer " + _token, "Accept: application/json", "X-Request-Id: " + request_id])
		if entry.method != "GET":
			headers.append("Content-Type: application/json")
			headers.append("Idempotency-Key: " + str(entry.idempotency_key))
		var methods := {"GET": HTTPClient.METHOD_GET, "POST": HTTPClient.METHOD_POST,
			"PUT": HTTPClient.METHOD_PUT, "PATCH": HTTPClient.METHOD_PATCH, "DELETE": HTTPClient.METHOD_DELETE}
		var err := http.request(base_url.trim_suffix("/") + str(entry.path), headers, methods[entry.method], str(entry.body))
		if err != OK:
			_release_http(request_id)
			_defer_request(request_id, "Could not start HTTP request: " + error_string(err))


func _http_done(result: int, status: int, _headers: PackedStringArray, bytes: PackedByteArray, request_id: String) -> void:
	_release_http(request_id)
	if not _pending.has(request_id):
		return
	if result != HTTPRequest.RESULT_SUCCESS:
		_defer_request(request_id, "HTTP transport interrupted; original request remains pending.")
		return
	var parsed: Variant = null
	if not bytes.is_empty():
		var parser := JSON.new()
		if parser.parse(bytes.get_string_from_utf8()) != OK:
			_defer_request(request_id, "Non-JSON HTTP response; original request remains pending.")
			return
		parsed = parser.data
	var entry: Dictionary = _pending[request_id]
	if request_id == _auth_request_id:
		_pending.erase(request_id)
		_auth_request_id = ""
		if status < 200 or status >= 300:
			disconnect_executor()
			http_failed.emit(request_id, status, parsed.get("error", {}) if parsed is Dictionary else {})
			return
		var principal: Dictionary = parsed.get("principal", {}) if parsed is Dictionary else {}
		var authenticated_id := str(principal.get("id", ""))
		if authenticated_id.is_empty() or (not _principal_id.is_empty() and authenticated_id != _principal_id):
			disconnect_executor()
			protocol_error.emit("Credentials do not match the transport state's principal. Use a separate state_path; pending requests were not replayed.")
			return
		_principal_id = authenticated_id
		_authenticated = true
		_save_state()
	if status >= 200 and status < 300:
		if entry.method == "DELETE" and str(entry.path).begins_with("/api/sessions/"):
			_forget_session(str(entry.get("session_id", "")))
		http_completed.emit(request_id, status, parsed)
		var resync_stream := str(entry.get("resync_stream", ""))
		if not resync_stream.is_empty():
			resume_subscription_after_snapshot(resync_stream)
	else:
		var error: Dictionary = parsed.get("error", {}) if parsed is Dictionary else {}
		if status == 404 and str(entry.path).split("?")[0] == "/api/sessions/" + str(entry.get("session_id", "")).uri_encode():
			_forget_session(str(entry.get("session_id", "")))
		if status == 401:
			disconnect_executor() # Require corrected credentials, rather than a reconnect loop.
		http_failed.emit(request_id, status, error)
	# Persist acknowledgement only after synchronous consumer delivery. If the
	# process stops during delivery, replay retains the original idempotency key.
	_pending.erase(request_id)
	_save_state()


func _release_http(request_id: String) -> void:
	if _active.has(request_id):
		var http: HTTPRequest = _active[request_id]
		_active.erase(request_id)
		http.queue_free()


func _defer_request(request_id: String, message: String) -> void:
	if not _pending.has(request_id):
		return
	var entry: Dictionary = _pending[request_id]
	var delay := int(entry.get("retry_ms", 500))
	entry["next_attempt_at"] = Time.get_ticks_msec() + delay
	entry["retry_ms"] = mini(delay * 2, 10000)
	protocol_error.emit(message)


func _subscribe_wire(stream_id: String) -> void:
	if _blocked_streams.has(stream_id):
		return
	_ws_command("subscribe", {"stream_id": stream_id, "after_seq": int(_subscriptions[stream_id])})


func _ws_command(type: String, payload: Dictionary) -> void:
	var id := _new_id()
	_commands[id] = {"type": type, "stream_id": payload.get("stream_id", "")}
	var err := _socket.send_text(JSON.stringify({"v": 1, "type": type, "id": id, "payload": payload}))
	if err != OK:
		protocol_error.emit("WebSocket send failed: %s" % error_string(err))
		_socket.close()


func _receive(event: Dictionary) -> void:
	var type := str(event.get("type", ""))
	if event.has("reply_to") or type == "command.rejected":
		var reply_to := str(event.get("reply_to", ""))
		var command: Dictionary = _commands.get(reply_to, {})
		_commands.erase(reply_to)
		var payload: Dictionary = event.get("payload", {})
		match type:
			"hello.accepted":
				_ws_ready = true
				_retry_delay_ms = 500
				for stream_id in _subscriptions:
					_subscribe_wire(stream_id)
				transport_ready.emit()
			"subscription.accepted":
				subscription_changed.emit(str(payload.get("stream_id", command.get("stream_id", ""))), true)
			"subscription.removed":
				subscription_changed.emit(str(payload.get("stream_id", command.get("stream_id", ""))), false)
			"command.rejected":
				var error: Dictionary = payload.get("error", {})
				var code := str(error.get("code", ""))
				protocol_error.emit(str(error.get("message", "WebSocket command rejected.")))
				if code in ["UNAUTHORIZED", "AUTH_REQUIRED", "AUTH_FAILED", "AUTH_REVOKED", "VERSION_MISMATCH", "FORBIDDEN"]:
					disconnect_executor()
				elif code in ["SESSION_NOT_FOUND", "NOT_FOUND", "RESOURCE_NOT_FOUND"]:
					var stream_id := str(command.get("stream_id", ""))
					if stream_id.begins_with("session:"):
						_forget_session(stream_id.trim_prefix("session:"))
				elif code == "CURSOR_EXPIRED":
					_recover_cursor(str(command.get("stream_id", "")), error.get("details", {}))
		return
	if str(event.get("api_version", "")) != "1" or not event.has("stream_id") or not event.has("seq"):
		protocol_error.emit("Invalid durable event envelope.")
		return
	var stream_id := str(event.stream_id)
	if not _subscriptions.has(stream_id):
		return
	var seq := int(event.seq)
	var previous := int(_subscriptions[stream_id])
	if seq <= previous:
		return # Deduplicate per stream, never globally.
	if seq != previous + 1:
		_socket.close() # Reconnect from the last contiguous cursor; do not skip a gap.
		return
	_subscriptions[stream_id] = seq
	if type == "reply.segment":
		var segment: Dictionary = event.get("data", {})
		reply_segment.emit(str(event.get("session_id", "")), str(event.get("run_id", "")), segment)
	event_received.emit(event)
	if type == "session.deleted":
		_forget_session(str(event.get("session_id", stream_id.trim_prefix("session:"))))
	_save_state()


func _forget_session(id: String) -> void:
	if id.is_empty():
		return
	var existed := _subscriptions.has("session:" + id) or session_id == id
	_subscriptions.erase("session:" + id)
	_blocked_streams.erase("session:" + id)
	if _ws_ready and existed:
		_ws_command("unsubscribe", {"stream_id": "session:" + id})
	if session_id == id:
		session_id = ""
	for request_id in _pending.keys():
		if str(_pending[request_id].get("session_id", "")) == id:
			if _active.has(request_id):
				var http: HTTPRequest = _active[request_id]
				http.cancel_request()
				_release_http(request_id)
			_pending.erase(request_id)
	_save_state()
	if existed:
		session_deleted.emit(id)


func _recover_cursor(stream_id: String, details: Dictionary) -> void:
	if stream_id.is_empty() or _blocked_streams.has(stream_id):
		return
	_blocked_streams[stream_id] = details
	_save_state()
	replay_reset_required.emit(stream_id, details)
	var path := ""
	var owner := ""
	if stream_id.begins_with("session:"):
		owner = stream_id.trim_prefix("session:")
		path = "/api/sessions/" + owner.uri_encode()
	elif stream_id.begins_with("companion:"):
		var parts := stream_id.split(":")
		if parts.size() == 3:
			path = "/api/companions/%s/%s" % [parts[1].uri_encode(), parts[2].uri_encode()]
	if not path.is_empty():
		var request_id := request("GET", path, {}, owner)
		if not request_id.is_empty():
			_pending[request_id]["resync_stream"] = stream_id
			_save_state()


func _save_state() -> void:
	if not _state_valid:
		return
	var durable: Dictionary = {}
	for request_id in _pending:
		if not _principal_id.is_empty() and _pending[request_id].get("persist", false):
			durable[request_id] = _pending[request_id]
	var content := JSON.stringify({"version": 1, "base_url": base_url.trim_suffix("/"),
		"client_id": _client_id, "principal_id": _principal_id,
		"session_id": session_id, "pending": durable,
		"subscriptions": _subscriptions, "blocked_streams": _blocked_streams})
	var temporary := state_path + ".tmp"
	var file := FileAccess.open(temporary, FileAccess.WRITE)
	if file == null:
		_state_valid = false
		protocol_error.emit("Cannot persist transport state; requests stopped to prevent unsafe replay.")
		return
	file.store_string(content)
	file.flush()
	file.close()
	var err := DirAccess.rename_absolute(ProjectSettings.globalize_path(temporary), ProjectSettings.globalize_path(state_path))
	if err != OK:
		_state_valid = false
		protocol_error.emit("Cannot atomically replace transport state; requests stopped.")


func _page(path: String, cursor: String, limit: int) -> String:
	return path + "?limit=" + str(limit) + ("&cursor=" + cursor.uri_encode() if not cursor.is_empty() else "")


func _new_id() -> String:
	return Crypto.new().generate_random_bytes(16).hex_encode()
