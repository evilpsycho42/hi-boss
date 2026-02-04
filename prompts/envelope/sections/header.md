from: {{ envelope.from }}
{% if envelope.senderLine %}
sender: {{ envelope.senderLine }}
{% endif %}
{% if envelope.channelMessageId %}
channel-message-id: {{ envelope.channelMessageId }}
{% endif %}
created-at: {{ envelope.createdAt.localIso }}
{% if envelope.deliverAt.utcIso %}
deliver-at: {{ envelope.deliverAt.localIso }}
{% endif %}
{% if envelope.cronId %}
cron-id: {{ envelope.cronId }}
{% endif %}
