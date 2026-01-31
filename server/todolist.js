// todolist.js
import crypto from "node:crypto";

// ---- A: TODO store (in-memory) ----
// id -> {id, text, dueAtMs|null, done, createdAtMs}
const todos = new Map();

function newId() {
  return crypto.randomUUID();
}

function toMsOrNull(isoOrNull) {
  if (!isoOrNull) return null;
  const ms = Date.parse(isoOrNull);
  return Number.isFinite(ms) ? ms : null;
}

function itemToPublic(item) {
  return {
    id: item.id,
    text: item.text,
    done: item.done,
    due_at: item.dueAtMs ? new Date(item.dueAtMs).toISOString() : null,
    created_at: new Date(item.createdAtMs).toISOString(),
  };
}

// ---- D: tool functions ----
function tool_todo_add({ text, due_at }) {
  const id = newId();
  const dueAtMs = toMsOrNull(due_at);
  const item = {
    id,
    text: String(text ?? ""),
    dueAtMs,
    done: false,
    createdAtMs: Date.now(),
  };
  todos.set(id, item);
  return itemToPublic(item);
}

function tool_todo_list() {
  const items = [...todos.values()].map(itemToPublic);
  items.sort((a, b) => (a.due_at ?? "").localeCompare(b.due_at ?? ""));
  return items;
}

function tool_todo_complete({ id }) {
  const item = todos.get(id);
  if (!item) return { ok: false, error: "not_found", id };
  item.done = true;
  return { ok: true, item: itemToPublic(item) };
}

function tool_todo_remove({ id }) {
  const ok = todos.delete(id);
  return { ok };
}

function tool_todo_update_due({ id, due_at }) {
  const item = todos.get(id);
  if (!item) return { ok: false, error: "not_found", id };
  item.dueAtMs = toMsOrNull(due_at);
  return { ok: true, item: itemToPublic(item) };
}

function runTodoTool(name, args) {
  switch (name) {
    case "todo_add":
      return tool_todo_add(args);
    case "todo_list":
      return tool_todo_list();
    case "todo_complete":
      return tool_todo_complete(args);
    case "todo_remove":
      return tool_todo_remove(args);
    case "todo_update_due":
      return tool_todo_update_due(args);
    default:
      return { ok: false, error: "unknown_tool", name };
  }
}

// ---- E: tools schema for OpenAI tool calling ----
const todoTools = [
  {
    type: "function",
    function: {
      name: "todo_add",
      description:
        "Add a TODO. due_at must be ISO8601 (e.g., 2025-12-14T09:00:00+09:00) or null.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" },
          due_at: { type: ["string", "null"] },
        },
        required: ["text", "due_at"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todo_list",
      description: "Get the TODO list (including IDs).",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todo_complete",
      description: "Mark a TODO as completed.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todo_remove",
      description: "Remove a TODO.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todo_update_due",
      description:
        "Update a TODO due date (due_at). due_at must be ISO8601 or null.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          due_at: { type: ["string", "null"] },
        },
        required: ["id", "due_at"],
        additionalProperties: false,
      },
    },
  },
];

// ---- C: register /api/todos route (separated from /api/chat) ----
function registerTodoRoutes(app) {
  app.get("/api/todos", (_req, res) => {
    const items = [...todos.values()].map(itemToPublic);
    console.log("GET /api/todos", items);
    items.sort((a, b) => (a.due_at ?? "").localeCompare(b.due_at ?? ""));
    res.json({ todos: items });
  });

  app.post("/api/todo/remove", (req, res) => {
    const id = String(req.body?.id ?? "");
    if (!id) return res.status(400).json({ ok: false, error: "missing_id" });
    const result = tool_todo_remove({ id });
    if (!result.ok) return res.status(404).json(result);
    res.json(result);
  });
}

export { registerTodoRoutes, todoTools, runTodoTool };
