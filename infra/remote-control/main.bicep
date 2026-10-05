@description('Azure region for all remote-control resources.')
param location string = resourceGroup().location

@description('Container image including tag.')
param containerImage string

@description('Public HTTPS origin, for example https://remote.example.com.')
param publicOrigin string

@description('Demo login username.')
param demoUserName string

@secure()
@description('Lowercase SHA-256 hash of the demo login password.')
param demoPasswordSha256 string

@description('Stable subject identifier used by the demo authentication provider.')
param demoSubject string = 'demo-user'

@description('Display name shown for the demo account.')
param demoDisplayName string = 'Demo User'

@description('Resource name prefix.')
@minLength(3)
param namePrefix string = 'swe-factory-remote'

var suffix = uniqueString(resourceGroup().id)
var storageName = take('swefactory${suffix}', 24)
var environmentName = '${namePrefix}-env'
var appName = '${namePrefix}-app'
var workspaceName = '${namePrefix}-logs'
var fileShareName = 'remote-metadata'

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: workspaceName
  location: location
  properties: {
    retentionInDays: 30
    sku: {
      name: 'PerGB2018'
    }
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    allowBlobPublicAccess: false
    allowSharedKeyAccess: true
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource metadataShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: fileService
  name: fileShareName
  properties: {
    enabledProtocols: 'SMB'
    shareQuota: 5
  }
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: workspace.properties.customerId
        sharedKey: workspace.listKeys().primarySharedKey
      }
    }
    zoneRedundant: false
  }
}

resource environmentStorage 'Microsoft.App/managedEnvironments/storages@2024-03-01' = {
  parent: environment
  name: 'metadata'
  properties: {
    azureFile: {
      accessMode: 'ReadWrite'
      accountKey: storage.listKeys().keys[0].value
      accountName: storage.name
      shareName: metadataShare.name
    }
  }
}

resource remoteApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        allowInsecure: false
        external: true
        targetPort: 8080
        transport: 'auto'
      }
      secrets: [
        {
          name: 'demo-password-sha256'
          value: demoPasswordSha256
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'remote-server'
          image: containerImage
          env: [
            {
              name: 'ASPNETCORE_ENVIRONMENT'
              value: 'Production'
            }
            {
              name: 'DemoAuth__UserName'
              value: demoUserName
            }
            {
              name: 'DemoAuth__PasswordSha256'
              secretRef: 'demo-password-sha256'
            }
            {
              name: 'DemoAuth__Subject'
              value: demoSubject
            }
            {
              name: 'DemoAuth__DisplayName'
              value: demoDisplayName
            }
            {
              name: 'RemoteServer__PublicOrigin'
              value: publicOrigin
            }
            {
              name: 'RemoteServer__DatabasePath'
              value: '/app/data/remote.db'
            }
            {
              name: 'RemoteServer__RequireHttps'
              value: 'true'
            }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/health/live'
                port: 8080
                scheme: 'HTTP'
              }
              initialDelaySeconds: 10
              periodSeconds: 20
              timeoutSeconds: 5
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/health/ready'
                port: 8080
                scheme: 'HTTP'
              }
              initialDelaySeconds: 5
              periodSeconds: 10
              timeoutSeconds: 5
              failureThreshold: 3
            }
          ]
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          volumeMounts: [
            {
              mountPath: '/app/data'
              volumeName: 'metadata'
            }
          ]
        }
      ]
      scale: {
        // Self-hosted SignalR routing is in memory. Do not scale until a backplane
        // or managed Azure SignalR Service is introduced.
        minReplicas: 1
        maxReplicas: 1
      }
      volumes: [
        {
          name: 'metadata'
          storageName: environmentStorage.name
          storageType: 'AzureFile'
        }
      ]
    }
  }
}

output remoteControlUrl string = 'https://${remoteApp.properties.configuration.ingress.fqdn}'
output containerAppName string = remoteApp.name
