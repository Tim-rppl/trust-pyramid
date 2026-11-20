from app.adapters.ai import AIClient
from app.log import event


def handler(note: str, client: AIClient) -> str:
    event("summary_requested", length=len(note))
    return client.summarize(note)
