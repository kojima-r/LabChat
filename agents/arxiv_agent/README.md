
pip install arxiv pyautogen
export OPENAI_API_KEY="sk-..."

pip install fastapi uvicorn

uvicorn server:app --host 0.0.0.0 --port 8000

```
curl -X POST http://localhost:8000/jobs \
  -H "Content-Type: application/json" \
  -d '{"text":"AutoGenに関する最近のarXiv研究を調査し解説してください"}'
```

```
curl http://localhost:8000/jobs/7b9d...
```
