## Pending Envelopes ({{ turn.envelopeCount }})

{% if turn.envelopeCount == 0 %}
No pending envelopes.
{% else %}
{% set blockIndex = 0 %}
{% for env in envelopes %}
{% set envelope = env %}
{% set prev = envelopes[loop.index0 - 1] %}
{% set isGroupContinuation = (not loop.first) and envelope.isGroup and prev and prev.isGroup and (prev.from == envelope.from) %}
{% if not isGroupContinuation %}
{% set blockIndex = blockIndex + 1 %}
{% endif %}
{% set envelopeBlockIndex = blockIndex %}
{% set showHeader = not isGroupContinuation %}
{% set isContinuation = isGroupContinuation %}
{% include "turn/sections/envelope.md" %}
{% if not loop.last %}
{% set next = envelopes[loop.index0 + 1] %}
{% set nextIsGroupContinuation = next and next.isGroup and envelope.isGroup and (next.from == envelope.from) %}
{% if not nextIsGroupContinuation %}

---

{% endif %}
{% endif %}
{% endfor %}
{% endif %}
