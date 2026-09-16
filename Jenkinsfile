pipeline {
  agent any

  options {
    disableConcurrentBuilds()
    timestamps()
  }

  stages {
    stage('Record revision') {
      steps {
        script {
          env.WELTBON_REVISION = sh(
            script: 'git rev-parse HEAD',
            returnStdout: true
          ).trim()
        }
        echo "Preparing deployment for ${env.WELTBON_REVISION}"
      }
    }

    stage('Deploy') {
      when {
        branch 'master'
      }
      steps {
        sshagent(credentials: ['weltbon-deploy-ssh']) {
          sh '''#!/usr/bin/env bash
            set -euo pipefail
            ssh -o BatchMode=yes -o StrictHostKeyChecking=yes \
              -o UserKnownHostsFile=/var/jenkins_home/.ssh/known_hosts \
              yalt@192.168.50.41 \
              "cd /home/yalt/Projects/Tech/web/Weltbon && ./scripts/deploy.sh && test \$(git rev-parse HEAD) = '${WELTBON_REVISION}'"
          '''
        }
      }
    }
  }
}
