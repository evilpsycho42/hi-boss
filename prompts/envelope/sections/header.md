from: {{ envelope.from }}
{% if envelope.fromName %}
from-name: {{ envelope.fromName }}
{% endif %}
from-boss: {{ envelope.fromBoss }}
created-at: {{ envelope.createdAt.localIso }}
{% if envelope.deliverAt.utcIso %}
deliver-at: {{ envelope.deliverAt.localIso }}
{% endif %}

