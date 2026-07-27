FROM alpine:3.20

RUN apk add --no-cache curl dcron tzdata

ENV TZ=Europe/Berlin
RUN cp /usr/share/zoneinfo/$TZ /etc/localtime && echo "$TZ" > /etc/timezone

COPY warmup-whisper.sh /usr/local/bin/warmup-whisper.sh
RUN chmod +x /usr/local/bin/warmup-whisper.sh
COPY crontab /etc/crontabs/root

CMD ["crond", "-f", "-d", "8"]
