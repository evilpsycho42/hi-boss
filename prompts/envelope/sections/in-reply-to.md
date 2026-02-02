{% if envelope.inReplyTo %}
in-reply-to-channel-message-id: {{ envelope.inReplyTo.channelMessageId }}
{% if envelope.inReplyTo.fromName %}
in-reply-to-from-name: {{ envelope.inReplyTo.fromName }}
{% endif %}
in-reply-to-text:
{{ envelope.inReplyTo.text }}
{% endif %}
