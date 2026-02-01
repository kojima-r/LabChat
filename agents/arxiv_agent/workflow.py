import logging
from pathlib import Path

MAX_REVISION = 3


def normalize_agent_output(research, logger: logging.Logger):
    """
    ResearchAgent の出力を
    Workflow で安全に使える str に変換
    """
    if isinstance(research, str):
        return research

    # AutoGen message dict 対応
    if isinstance(research, dict):
        if isinstance(research.get("content"), str):
            return research["content"]

    logger.warning("Unexpected agent output format:")
    logger.warning(str(research))
    return ""


def run_writing_workflow(
    planning_agent,
    research_agent,
    writer_agent,
    critic_agent,
    task: str,
    output_path: str = "work/output.txt",
    logger: logging.Logger | None = None,
    verbose: bool = True,
):
    """
    Workflow 内で messages を保持しつつ
    承認されるまで Writer ↔ Critic を回す
    """

    if logger is None:
        logger = logging.getLogger(__name__)

    messages = []

    # --- Planning ---
    if verbose:
        logger.info("--- Planning ---")

    messages.append({"role": "user", "content": task})
    plan_raw = planning_agent.generate_reply(messages=messages)
    plan = normalize_agent_output(plan_raw, logger)

    messages.append(
        {"role": "assistant", "name": "PlanningAgent", "content": plan}
    )

    if verbose:
        logger.info("[PlanningAgent Output]")
        logger.info(plan)

    # --- Research ---
    if verbose:
        logger.info("--- Research ---")

    messages.append({"role": "user", "content": plan})
    research_raw = research_agent.generate_reply(messages=messages)
    research = normalize_agent_output(research_raw, logger)

    messages.append(
        {"role": "assistant", "name": "ResearchAgent", "content": research}
    )

    if verbose:
        logger.info("[ResearchAgent Output]")
        logger.info(research)

    # --- Writing / Critic loop ---
    writer_input = research
    final_text = None

    for i in range(MAX_REVISION):
        if verbose:
            logger.info(f"--- Writing (rev {i + 1}) ---")

        messages.append({"role": "user", "content": writer_input})
        draft_raw = writer_agent.generate_reply(messages=messages)
        draft = normalize_agent_output(draft_raw, logger)

        messages.append(
            {"role": "assistant", "name": "WriterAgent", "content": draft}
        )

        if verbose:
            logger.info("[WriterAgent Draft]")
            logger.info(draft)

        # --- Critic ---
        if verbose:
            logger.info("--- Critic ---")

        messages.append({"role": "user", "content": draft})
        critique_raw = critic_agent.generate_reply(messages=messages)
        critique = normalize_agent_output(critique_raw, logger)

        messages.append(
            {"role": "assistant", "name": "CriticAgent", "content": critique}
        )

        if verbose:
            logger.info("[CriticAgent Feedback]")
            logger.info(critique)

        # --- 判定 ---
        if "承認" in critique:
            logger.info("✔ CriticAgent approved the draft")
            final_text = draft
            break
        else:
            logger.info("✘ Revision required, sending feedback to WriterAgent")
            writer_input = f"""
以下の指摘を反映して文章を書き直してください。

【指摘】
{critique}

【元の文章】
{draft}
"""

    if final_text is None:
        logger.error("Maximum revision count exceeded without approval")
        raise RuntimeError("最大修正回数を超えても承認されませんでした")

    # --- ファイル書き出し ---
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(final_text)

    logger.info(f"Final article written to: {output_path}")

    return final_text, messages

