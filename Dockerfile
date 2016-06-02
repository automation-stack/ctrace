# > docker run -i -t --security-opt seccomp:unconfined -v $PWD:/var/opt/src $IMAGE

FROM ubuntu:14.04

# Common enviromnent variables
ENV TERM=xterm
ENV DEBIAN_FRONTEND noninteractive

# Add proper locales
RUN locale-gen ru_RU.UTF-8
RUN dpkg-reconfigure debconf locales
ENV LANG=ru_RU.UTF-8 LC_ALL=ru_RU.UTF-8 LANGUAGE=ru_RU:ru

# apt-get configuration
RUN rm -rf /var/lib/apt/lists/*
RUN apt-get update --fix-missing

# Install requred pacakges
#   strace required "--security-opt seccomp:unconfined" option on container running
RUN apt-get update --fix-missing && \
    apt-get install -y curl \
        strace

# Install NodeJs
RUN curl -sL https://deb.nodesource.com/setup_6.x | bash - && apt-get install -y nodejs

RUN /bin/bash
