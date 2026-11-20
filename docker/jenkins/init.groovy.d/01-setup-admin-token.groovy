import jenkins.model.*
import hudson.security.*
import jenkins.security.ApiTokenProperty
import java.io.File

def instance = Jenkins.getInstanceOrNull()
if (instance == null) {
    return
}

def adminUser = System.getenv("JENKINS_ADMIN_USER") ?: "admin"
def adminPass = System.getenv("JENKINS_ADMIN_PASSWORD") ?: "admin123"
def tokenFile = new File("/var/jenkins_home/.ai-pipeline-api-token")

// 1. Configure HudsonPrivateSecurityRealm & create admin user if not exists
def realm = instance.getSecurityRealm()
if (!(realm instanceof HudsonPrivateSecurityRealm)) {
    realm = new HudsonPrivateSecurityRealm(false)
    instance.setSecurityRealm(realm)
}

def user = realm.getAllUsers().find { it.getId() == adminUser }
if (user == null) {
    user = realm.createAccount(adminUser, adminPass)
    println("[ai-pipeline-init] Created Jenkins admin user: ${adminUser}")
}

// 2. Grant authenticated users full control (disable anonymous access)
def strategy = new FullControlOnceLoggedInAuthorizationStrategy()
strategy.setAllowAnonymousRead(false)
instance.setAuthorizationStrategy(strategy)
instance.save()

// 3. Generate a persistent API token once and store it for scripts/setup-jenkins.ts
if (!tokenFile.exists() || tokenFile.text.trim().isEmpty()) {
    def prop = user.getProperty(ApiTokenProperty.class)
    if (prop == null) {
        prop = new ApiTokenProperty()
        user.addProperty(prop)
    }
    def result = prop.tokenStore.generateNewToken("ai-pipeline-auto-token")
    user.save()
    tokenFile.text = result.plainValue.trim() + "\n"
    println("[ai-pipeline-init] Generated Jenkins API token for '${adminUser}' at ${tokenFile.absolutePath}")
} else {
    println("[ai-pipeline-init] Existing Jenkins API token found at ${tokenFile.absolutePath}")
}
