module.exports = {
  "components": [
    {
      "id": "webhook_1",
      "provider": "webhook",
      "config": {
        "hideForm": true,
        "mode": "Source",
        "parameters": {},
        "type": "webhook"
      }
    },
    {
      "id": "question_1",
      "provider": "question",
      "config": {
        "type": "question"
      },
      "input": [
        {
          "lane": "text",
          "from": "webhook_1"
        }
      ]
    },
    {
      "id": "llm_anthropic_1",
      "provider": "llm_openai",
      "config": {
        "profile": "gpt-4-1",
        "gpt-4-1": {
          "apikey": "${ROCKETRIDE_OPENAI_KEY}"
        },
        "parameters": {}
      },
      "input": [
        {
          "lane": "questions",
          "from": "question_1"
        }
      ]
    },
    {
      "id": "guardrails_1",
      "provider": "guardrails",
      "config": {
        "profile": "custom",
        "custom": {
          "policy_mode": "warn",
          "enable_prompt_injection": true,
          "enable_content_safety": true,
          "enable_pii_detection": true,
          "enable_hallucination_check": false,
          "expected_format": "json",
          "max_input_length": 0,
          "max_tokens_estimate": 0,
          "blocked_topics": [],
          "allowed_topics": []
        }
      },
      "input": [
        {
          "lane": "answers",
          "from": "llm_anthropic_1"
        }
      ]
    },
    {
      "id": "response_answers_1",
      "provider": "response_answers",
      "config": {
        "laneName": "answers"
      },
      "input": [
        {
          "lane": "answers",
          "from": "guardrails_1"
        }
      ]
    }
  ],
  "source": "webhook_1",
  "project_id": "32dcd7d6-7d16-46d6-b9ca-aa99f295e471",
  "viewport": {
    "x": 0,
    "y": 0,
    "zoom": 1
  },
  "version": 1
};
