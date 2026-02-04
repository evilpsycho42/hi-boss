from: {{ envelope.from }}
{% if envelope.senderLine %}
sender: {{ envelope.senderLine }}
{% endif %}
{% if envelope.channelMessageId %}
channel-message-id: {{ envelope.channelMessageId }}
{% endif %}
created-at: {{ envelope.createdAt.iso }}
{% if envelope.deliverAt.present %}
deliver-at: {{ envelope.deliverAt.iso }}
{% endif %}
{% if envelope.cronId %}
cron-id: {{ envelope.cronId }}
{% endif %}
