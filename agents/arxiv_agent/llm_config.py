def get_llm_config():
    return {
        "model": "gpt-4o-mini",
        "temperature": 0.3,
    }


def get_llm_config_research():
    llm_config_research = {
        "model": "gpt-4o-mini",   # 例
        "temperature": 0.3,
        "functions": [
            {
                "name": "search_arxiv",
                "description": "Search arXiv for academic papers",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Search query for arXiv"
                        },
                        "max_results": {
                            "type": "integer",
                            "description": "Maximum number of papers",
                            "default": 5
                        }
                    },
                    "required": ["query"]
                }
            }
        ]
    }
    return llm_config_research
