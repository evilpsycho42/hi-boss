from: {{ envelope.from }}
status: {{ envelope.status }}
{% if envelope.fromName %}
from-name: {{ envelope.fromName }}
{% endif %}
{% if envelope.channelMessageId %}
channel-message-id: {{ envelope.channelMessageId }}
{% endif %}
{% if envelope.isGroup == false %}
created-at: {{ envelope.createdAt.localIso }}
{% endif %}
{% if envelope.deliverAt.utcIso %}
deliver-at: {{ envelope.deliverAt.localIso }}
{% endif %}
