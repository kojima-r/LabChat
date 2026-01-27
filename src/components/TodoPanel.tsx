import { useEffect, useRef, useState } from "react";

export type Todo = {
  id: string;
  text: string;
  done: boolean;
  due_at: string | null;     // ISO8601 or null
  created_at: string;
};

type Props = {
  refreshKey: number; // Appから更新トリガーを渡す
};

export default function TodoPanel({ refreshKey }: Props) {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [error, setError] = useState<string | null>(null);

  // todoId -> timeoutId
  const timersRef = useRef<Map<string, number>>(new Map());

  const clearAllTimers = () => {
    for (const id of timersRef.current.values()) {
      window.clearTimeout(id);
    }
    timersRef.current.clear();
  };

  const showDueNotification = (t: Todo) => {
    // OS通知が許可されていれば Notification、ダメなら alert
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification("TODO期限です", { body: t.text });
    } else {
      alert(`⏰ TODO期限です: ${t.text}\n${t.due_at ?? ""}`);
    }
  };

  const scheduleNotifications = (list: Todo[]) => {
    clearAllTimers();

    const now = Date.now();
    for (const t of list) {
      if (t.done) continue;
      if (!t.due_at) continue;

      const dueMs = Date.parse(t.due_at);
      if (!Number.isFinite(dueMs)) continue;

      const delay = dueMs - now;
      const timeoutMs = Math.max(0, delay);

      const tid = window.setTimeout(() => showDueNotification(t), timeoutMs);
      timersRef.current.set(t.id, tid);
    }
  };

  const fetchTodos = async () => {
    try {
      setError(null);
      const r = await fetch("/api/todos");
      if (!r.ok) throw new Error(await r.text());
      const j = await r.json();
      const list: Todo[] = j.todos ?? [];
      console.log("Fetched todos:", list);
      setTodos(list);
      scheduleNotifications(list);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  };

  // 初回 + refreshKeyが変わったら再取得
  useEffect(() => {
    void fetchTodos();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  // アンマウントでタイマー解除
  useEffect(() => {
    return () => clearAllTimers();
  }, []);

  const requestNotifyPermission = async () => {
    if (!("Notification" in window)) return;
    await Notification.requestPermission();
  };

  return (
    <div style={{ marginTop: 16, padding: 12, border: "1px solid #444", borderRadius: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
        <h3 style={{ margin: 0 }}>TODO</h3>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={fetchTodos}>再取得</button>
          <button onClick={requestNotifyPermission}>通知を許可</button>
        </div>
      </div>

      {error && <div style={{ marginTop: 8, color: "tomato" }}>{error}</div>}

      <ul style={{ marginTop: 10 }}>
        {todos.map((t) => (
          <li key={t.id} style={{ marginBottom: 8, opacity: t.done ? 0.6 : 1 }}>
            <div><strong>{t.text}</strong></div>
            <div style={{ fontSize: 12, opacity: 0.8 }}>
              due: {t.due_at ?? "-"} / done: {String(t.done)}
            </div>
          </li>
        ))}
        {todos.length === 0 && <li>TODOはありません</li>}
      </ul>
    </div>
  );
}
