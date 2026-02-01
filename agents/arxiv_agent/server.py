from fastapi import FastAPI, BackgroundTasks
from pydantic import BaseModel
import uuid
import os

from main import run_job
import logging

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(message)s",
)


app = FastAPI(title="AutoGen Job Server")

WORK_ROOT = "work"
os.makedirs(WORK_ROOT, exist_ok=True)


class JobRequest(BaseModel):
    text: str


@app.post("/jobs")
def submit_job(req: JobRequest, background_tasks: BackgroundTasks):
    job_id = str(uuid.uuid4())
    job_dir = os.path.join(WORK_ROOT, job_id)
    os.makedirs(job_dir, exist_ok=True)

    with open(os.path.join(job_dir, "status.txt"), "w") as f:
        f.write("RUNNING")

    background_tasks.add_task(run_job, req.text, job_dir, job_id)

    return {
        "job_id": job_id,
        "status": "RUNNING"
    }


@app.get("/jobs/{job_id}")
def get_job(job_id: str):
    job_dir = os.path.join(WORK_ROOT, job_id)

    if not os.path.exists(job_dir):
        return {"error": "job not found"}

    status_path = os.path.join(job_dir, "status.txt")
    final_path = os.path.join(job_dir, "final_article.txt")

    status = open(status_path).read() if os.path.exists(status_path) else "UNKNOWN"

    response = {
        "job_id": job_id,
        "status": status,
    }

    if os.path.exists(final_path):
        response["result"] = open(final_path, encoding="utf-8").read()

    return response

