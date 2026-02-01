from autogen import AssistantAgent
from tools.arxiv_tool import search_arxiv

# utils
def load_prompt(path: str) -> str:
    with open(path, "r", encoding="utf-8") as f:
        return f.read()

# agents

def create_planning_agent(llm_config):
    return AssistantAgent(
        name="PlanningAgent",
        llm_config=llm_config,
        system_message=load_prompt("prompts/planning.txt"),
    )


def create_research_agent(llm_config):
    return AssistantAgent(
        name="ResearchAgent",
        llm_config=llm_config,
        system_message=load_prompt("prompts/research.txt"),
        function_map={
            #"search_arxiv": lambda q, m=5: search_arxiv(q, m, logger)
            "search_arxiv": search_arxiv
        }
    )

def create_writer_agent(llm_config):
    return AssistantAgent(
        name="WriterAgent",
        llm_config=llm_config,
        system_message=load_prompt("prompts/writer.txt"),
    )

def create_critic_agent(llm_config):
    return AssistantAgent(
        name="CriticAgent",
        llm_config=llm_config,
        system_message=load_prompt("prompts/critic.txt"),
    )


