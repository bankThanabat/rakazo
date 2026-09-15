"""Operator-installed customer flow component. No OpenRAG or Langflow source patch."""

import asyncio
import json
from typing import ClassVar
from urllib.parse import urlsplit
from uuid import uuid4

import httpx
from langchain.agents import create_agent
from langchain.agents.middleware import ModelCallLimitMiddleware
from langchain_core.tools import StructuredTool
from langchain_openai import ChatOpenAI
from lfx.custom.custom_component.component import Component
from lfx.io import MultilineInput, Output, SecretStrInput, StrInput
from lfx.schema.message import Message


def secret(value):
    return (
        value.get_secret_value() if hasattr(value, "get_secret_value") else str(value)
    )


def endpoint(value):
    url = urlsplit(value)
    if (
        url.scheme not in ("http", "https")
        or not url.hostname
        or url.username
        or url.password
        or url.query
        or url.fragment
    ):
        raise ValueError("Invalid customer service endpoint")
    return value.rstrip("/")


async def call(client, base, token, path, body=None):
    async with client.stream(
        "GET" if body is None else "POST",
        f"{base}{path}",
        headers={"Authorization": f"Bearer {token}"},
        **({} if body is None else {"json": body}),
    ) as response:
        if not response.is_success:
            raise RuntimeError("Customer operation is unavailable")
        chunks = []
        size = 0
        async for chunk in response.aiter_bytes():
            size += len(chunk)
            if size > 1_000_000:
                raise RuntimeError("Customer operation exceeded the size limit")
            chunks.append(chunk)
        return json.loads(b"".join(chunks))


def tool_for(spec, client, base, token):
    # The closure owns credentials; no model argument can replace them.
    async def execute(**arguments):
        return await call(
            client,
            base,
            token,
            "",
            {
                "name": spec["name"],
                "callId": str(uuid4()),
                "arguments": arguments,
            },
        )

    return StructuredTool.from_function(
        coroutine=execute,
        name=spec["name"],
        description=spec["description"],
        args_schema=spec["inputSchema"],
    )


async def customer_reply(
    *,
    instructions,
    transcript,
    execution_endpoint,
    execution_token,
    model_base,
    model_key,
    model_id,
):
    messages = json.loads(transcript)
    if not isinstance(messages, list) or not 1 <= len(messages) <= 100:
        raise ValueError("Invalid customer transcript")
    for message in messages:
        if (
            not isinstance(message, dict)
            or set(message) != {"role", "content"}
            or message["role"] not in ("user", "assistant")
            or not isinstance(message["content"], str)
        ):
            raise ValueError("Invalid customer transcript")
    if messages[-1]["role"] != "user":
        raise ValueError("Customer turn must end with a user message")
    base = endpoint(execution_endpoint)
    model_url = endpoint(model_base)
    async with (
        asyncio.timeout(55),
        httpx.AsyncClient(
            timeout=20, follow_redirects=False, trust_env=False
        ) as client,
    ):
        catalog = await call(client, base, execution_token, "")
        tools = [
            tool_for(spec, client, base, execution_token) for spec in catalog["tools"]
        ]
        model = ChatOpenAI(
            base_url=model_url,
            api_key=model_key,
            model=model_id,
            use_responses_api=False,
            max_retries=0,
            timeout=50,
            max_tokens=8192,
            streaming=False,
        )
        # Uses Langflow's LangChain agent engine; no Rakazo staff agent or persisted memory.
        agent = create_agent(
            model=model,
            tools=tools,
            system_prompt=instructions,
            middleware=[ModelCallLimitMiddleware(run_limit=16, exit_behavior="error")],
        )
        result = await agent.ainvoke({"messages": messages})
        last = result["messages"][-1]
        if getattr(last, "type", None) != "ai" or getattr(last, "tool_calls", None):
            raise RuntimeError("Customer agent did not finish")
        content = last.content
        if isinstance(content, list):
            content = "".join(
                part.get("text", "")
                for part in content
                if isinstance(part, dict) and part.get("type") == "text"
            )
        if not isinstance(content, str) or not 1 <= len(content.strip()) <= 16_000:
            raise RuntimeError("Customer agent returned no usable reply")
        return content.strip()


class RakazoCustomerAgent(Component):
    display_name = "Rakazo customer agent"
    description = (
        "Run an approved customer turn with scoped Rakazo tools and model access."
    )
    name = "RakazoCustomerAgent"
    inputs: ClassVar[list] = [
        StrInput(name="protocol_version", value="1", advanced=True),
        MultilineInput(name="instructions", required=True),
        MultilineInput(name="transcript", required=True, trace_as_metadata=False),
        StrInput(name="execution_endpoint", required=True, trace_as_metadata=False),
        SecretStrInput(name="execution_token", required=True),
        StrInput(name="model_base", required=True, trace_as_metadata=False),
        SecretStrInput(name="model_key", required=True),
        StrInput(name="model_id", required=True),
    ]
    outputs: ClassVar[list] = [
        Output(display_name="Reply", name="message", method="reply")
    ]

    async def reply(self) -> Message:
        try:
            text = await customer_reply(
                instructions=self.instructions,
                transcript=self.transcript,
                execution_endpoint=self.execution_endpoint,
                execution_token=secret(self.execution_token),
                model_base=self.model_base,
                model_key=secret(self.model_key),
                model_id=self.model_id,
            )
            return Message(text=text)
        except Exception:  # noqa: BLE001 - sanitize all provider and credential errors
            # Keep request headers, provider errors and credentials out of returned flow errors.
            raise RuntimeError("Customer reply service is unavailable") from None
