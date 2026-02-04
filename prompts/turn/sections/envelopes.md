{% if turn.envelopeCount == 0 %}
No pending envelopes.
{% else %}
{% for env in envelopes %}
{% set envelope = env %}
{% include "turn/sections/envelope.md" %}
{% if not loop.last %}

---

{% endif %}
{% endfor %}
{% endif %}
