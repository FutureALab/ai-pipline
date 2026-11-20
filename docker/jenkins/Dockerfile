FROM jenkins/jenkins:lts-jdk17

ENV JAVA_OPTS="-Djenkins.install.runSetupWizard=false"

# Pre-install Pipeline (workflow-aggregator) and Git plugins so XML <flow-definition> jobs work out of the box
RUN jenkins-plugin-cli --plugins \
    workflow-aggregator \
    git

# Auto-configure admin user and generate an API token on first startup
COPY init.groovy.d/01-setup-admin-token.groovy /usr/share/jenkins/ref/init.groovy.d/01-setup-admin-token.groovy
