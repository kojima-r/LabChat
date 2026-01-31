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
  onDueNotification?: (text: string, todo: Todo) => void;
  isEnglishConversation?: boolean;
};

export default function TodoPanel({
  refreshKey,
  onDueNotification,
  isEnglishConversation = false,
}: Props) {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [error, setError] = useState<string | null>(null);

  const pollTimerRef = useRef<number | null>(null);

  const clearPollTimer = () => {
    if (pollTimerRef.current != null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  const showDueNotification = async (t: Todo) => {
    const text = isEnglishConversation
      ? `Tool message: Please notify the user that the task "${t.text}" is due.`
      : `Tool message: ユーザに タスク「${t.text}」の時刻になったことを通知してください`;
    // OS通知が許可されていれば Notification、ダメなら alert
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification(
        isEnglishConversation ? "TODO is due" : "TODO期限です",
        { body: t.text }
      );
    } else {
      alert(
        isEnglishConversation
          ? `⏰ TODO is due: ${t.text}\n${t.due_at ?? ""}`
          : `⏰ TODO期限です: ${t.text}\n${t.due_at ?? ""}`
      );
    }
    onDueNotification?.(text, t);
    try {
      const r = await fetch("/api/todo/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: t.id }),
      });
      if (!r.ok) throw new Error(await r.text());
      setTodos((prev) => prev.filter((item) => item.id !== t.id));
    } catch (e) {
      console.warn("Failed to remove due todo:", e);
    }
  };

  const getJstIsoString = (now: Date): string => {
    // 'sv' ロケールは 'YYYY-MM-DD HH:mm:ss' 形式 (24時間表記)
    const jstString = now.toLocaleString('sv', { timeZone: 'Asia/Tokyo' });
    // 空白をTに置換し、タイムゾーン+09:00を付与
    return jstString.replace(' ', 'T') + '+09:00';
  };
  const scheduleNotifications = (list: Todo[]) => {
    clearPollTimer();

    const checkDue = () => {
      console.log("Check...");
      const now = new Date();
      for (const t of list) {
        if (t.done) continue;
        if (!t.due_at) continue;
        const due_at = new Date(t.due_at);
        console.log("Checking due for todo:", t," due:", getJstIsoString(due_at),"  now:", getJstIsoString(now));

        if (due_at <= now) {
          t.done=true; // 重複通知防止
          void showDueNotification(t);
        }
      }
    };

    checkDue();
    pollTimerRef.current = window.setInterval(checkDue, 5_000);
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
    return () => {
      clearPollTimer();
    };
  }, []);

  const requestNotifyPermission = async () => {
    if (!("Notification" in window)) return;
    await Notification.requestPermission();
  };

  const removeAllTodos = async () => {
    try {
      setError(null);
      await Promise.all(
        todos.map((t) =>
          fetch("/api/todo/remove", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: t.id }),
          })
        )
      );
      setTodos([]);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  };

  return (
    <div style={{ marginTop: 16, padding: 12, border: "1px solid #444", borderRadius: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
        <h3 style={{ margin: 0 }}>{isEnglishConversation ? "TODOs" : "TODO"}</h3>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={fetchTodos}>
            Refresh
          </button>
          <button onClick={removeAllTodos} disabled={todos.length === 0}>
            Remove all
          </button>
          <button onClick={requestNotifyPermission}>
            Allow notifications
          </button>
        </div>
      </div>

      {error && <div style={{ marginTop: 8, color: "tomato" }}>{error}</div>}

      <ul style={{ marginTop: 10 }}>
        {todos.map((t) => (
          <li key={t.id} style={{ marginBottom: 8, opacity: t.done ? 0.6 : 1 }}>
            <div><strong>{t.text}</strong></div>
            <div style={{ fontSize: 12, opacity: 0.8 }}>
              due: {t.due_at ? getJstIsoString(new Date(t.due_at)) : "-"} / done: {String(t.done)}
            </div>
          </li>
        ))}
        {todos.length === 0 && (
          <li>No TODOs</li>
        )}
      </ul>
    </div>
  );
}
