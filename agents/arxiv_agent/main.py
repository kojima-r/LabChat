import autogen
from autogen import UserProxyAgent
from llm_config import get_llm_config, get_llm_config_research
from agents import (
    create_planning_agent,
    create_research_agent,
    create_writer_agent,
    create_critic_agent,
)
from workflow import run_writing_workflow

import os
import logging
from pathlib import Path

# =========================
# logging
# =========================
def setup_job_logger(job_id: str, job_dir: str) -> logging.Logger:
    """
    job_id 専用の logger を作成
    出力先: work/{job_id}/log.txt
    """
    log_path = Path(job_dir) / "log.txt"
    log_path.parent.mkdir(parents=True, exist_ok=True)

    logger = logging.getLogger(f"job.{job_id}")
    logger.setLevel(logging.INFO)
    logger.propagate = False

    if not logger.handlers:
        handler = logging.FileHandler(log_path, encoding="utf-8")
        formatter = logging.Formatter(
            "%(asctime)s [%(levelname)s] [%(name)s] %(message)s"
        )
        handler.setFormatter(formatter)
        logger.addHandler(handler)

    # root logger にも接続（tool / autogen ログ吸収用）
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    if not any(
        isinstance(h, logging.FileHandler) and h.baseFilename == str(log_path)
        for h in root.handlers
    ):
        root.addHandler(handler)

    return logger


def extract_message(messages):
    last_msgs = {}
    for msg in messages:
        name = msg.get("name")
        content = msg.get("content")
        if not isinstance(content, dict):
            last_msgs[name] = content
    return str(last_msgs)


# =========================
# Phase 1: Exploration
# =========================
def run_exploration_phase(user_task: str, job_dir: str, logger) -> str:
    """
    GroupChatManagerを用いた探索・議論フェーズ
    """

    logger.info("=== Phase 1: Exploration ===")

    llm_config_research = get_llm_config_research()
    llm_config = get_llm_config()

    prompt = """
まずは執筆方針を話しあってください
"""

    user = UserProxyAgent(
        name="User",
        human_input_mode="NEVER",
        code_execution_config={
            "use_docker": False,
            "work_dir": job_dir,
        },
    )

    agents = [
        user,
        create_planning_agent(llm_config),
        create_research_agent(llm_config_research),
        create_writer_agent(llm_config),
        create_critic_agent(llm_config),
    ]

    groupchat = autogen.GroupChat(
        agents=agents,
        messages=[],
        max_round=8,
    )

    manager = autogen.GroupChatManager(
        groupchat=groupchat,
        llm_config=llm_config,
    )

    logger.info("Exploration chat started")
    user.initiate_chat(manager, message=user_task + prompt)
    logger.info("Exploration chat finished")

    plan = extract_message(groupchat.messages)
    logger.info("Extracted plan:")
    logger.info(plan)

    return plan


# =========================
# Phase 2: Production
# =========================
def run_production_phase(plan: str, job_dir: str, logger):
    """
    Workflowベースの確定・生成フェーズ
    """

    logger.info("=== Phase 2: Production ===")

    llm_config = get_llm_config()
    llm_config_research = get_llm_config_research()

    planning_agent = create_planning_agent(llm_config)
    research_agent = create_research_agent(llm_config_research)
    writer_agent = create_writer_agent(llm_config)
    critic_agent = create_critic_agent(llm_config)

    run_writing_workflow(
        planning_agent=planning_agent,
        research_agent=research_agent,
        writer_agent=writer_agent,
        critic_agent=critic_agent,
        task=plan,
        output_path=os.path.join(job_dir, "final_article.txt"),
    )

    logger.info("Production phase finished")


# =========================
# job
# =========================
def run_job(user_task: str, job_dir: str, job_id: str):
    logger = setup_job_logger(job_id, job_dir)

    logger.info("=== JOB START ===")
    logger.info(f"job_id: {job_id}")

    os.makedirs(job_dir, exist_ok=True)

    # Phase 1
    final_plan = run_exploration_phase(user_task, job_dir, logger)

    logger.info("=== 固定された執筆方針 ===")
    logger.info(final_plan)

    plan = (
        user_task
        + "これを次の方針で達成し，最終原稿をWriterAgentが書いてください："
        + final_plan
    )
    logger.info("Final task for production:")
    logger.info(plan)

    # Phase 2
    run_production_phase(plan, job_dir, logger)

    logger.info(f"✔ 最終原稿を {job_dir}/final_article.txt に保存しました")

    with open(os.path.join(job_dir, "status.txt"), "w") as f:
        f.write("DONE")

    logger.info("=== JOB DONE ===")


# =========================
# main
# =========================
def main():
    user_task = """
    AutoGenに関する最近のarXiv研究を調査し、
    日本語で研究解説記事を書いてください。
    読者は機械学習分野の研究者を想定します。
    """
    run_job(user_task, "work", "test")


if __name__ == "__main__":
    main()

