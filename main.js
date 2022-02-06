const api = require('./api');
const mqtt = require('./mqtt');
const fs = require('fs');
const PlejdService = require('./ble.bluez');
const SceneManager = require('./scene.manager');
const version = "0.4.7";
var configPi;
const path = "/etc/nibepi"
if (!fs.existsSync(path)) {
    exec(`sudo mount -o remount,rw / && sudo mkdir ${path} && sudo chown ${process.env.USER}:${process.env.USER} ${path}`, function(error, stdout, stderr) {
        if(error) {
            exec(`mkdir ${path} && chown ${process.env.USER}:${process.env.USER} ${path}`, function(error, stdout, stderr) {
                if(error) {console.log('Error creating config directory')} else { console.log('Created config directory')}
            });
        } else {
            console.log(`Configuration directory created ${path}`);
        }
    });
}

function requireF(modulePath){ // force require
    try {
     return require(modulePath);
    }
    catch (e) {
        console.log('Config file not found, loading default.');
        let conf = require(__dirname+'/default.json')
        fs.writeFile(path+'/config.json', JSON.stringify(conf,null,2), function(err) {
            if(err) console.log(err)
        });
        return conf;
    }
}
configPi = requireF(path+'/config.json');
async function main() {
  console.log('starting Plejd add-on v. ' + version);

  const config = {
    site: configPi.plejd.cloud_name || "Default Site",
    username: configPi.plejd.cloud_user || "",
    password: configPi.plejd.cloud_pass || "",
    mqttBroker: `mqtt://${configPi.plejd.host}:${configPi.plejd.port}` || "mqtt://localhost",
    mqttUsername: configPi.plejd.user || "",
    mqttPassword: configPi.plejd.pass || "",
    includeRoomsAsLights: process.env.PLEJD_INCLUDE_ROOMS_AS_LIGHTS || false,
    connectionTimeout: process.env.BLUETOOTH_TIMEOUT || 4,
    writeQueueWaitTime: process.env.BLUETOOTH_WAIT || 600,
  }

  if (!config.connectionTimeout) {
    config.connectionTimeout = 2;
  }

  const plejdApi = new api.PlejdApi(config.site, config.username, config.password);
  const client = new mqtt.MqttClient(config.mqttBroker, config.mqttUsername, config.mqttPassword);

  ['SIGINT', 'SIGHUP', 'SIGTERM'].forEach(signal => {
    process.on(signal, () => {
      console.log(`Received ${signal}. Cleaning up.`);
      client.disconnect(() => process.exit(0));
    });
  });

  plejdApi.login().then(() => {
    // load all sites and find the one that we want (from config)
    plejdApi.getSites().then((site) => {
      // load the site and retrieve the crypto key
      plejdApi.getSite(site.site.siteId).then((cryptoKey) => {
        // parse all devices from the API
        const devices = plejdApi.getDevices();

        client.on('connected', () => {
          console.log('plejd-mqtt: connected to mqtt.');
          client.discover(devices);
        });

        client.init();

        // init the BLE interface
        const sceneManager = new SceneManager(plejdApi.site, devices);
        const plejd = new PlejdService(cryptoKey, devices, sceneManager, config.connectionTimeout, config.writeQueueWaitTime, true);
        plejd.on('connectFailed', () => {
          console.log('plejd-ble: were unable to connect, will retry connection in 10 seconds.');
          setTimeout(() => {
            plejd.init();
          }, 10000);
        });

        plejd.init();

        plejd.on('authenticated', () => {
          console.log('plejd: connected via bluetooth.');
        });

        // subscribe to changes from Plejd
        plejd.on('stateChanged', (deviceId, command) => {
          client.updateState(deviceId, command);
        });

        plejd.on('sceneTriggered', (deviceId, scene) => {
          client.sceneTriggered(scene);
        });

        // subscribe to changes from HA
        client.on('stateChanged', (device, command) => {
          const deviceId = device.id;

          if (device.typeName === 'Scene') {
            // we're triggering a scene, lets do that and jump out.
            // since scenes aren't "real" devices.
            plejd.triggerScene(device.id);
            return;
          }

          let state = 'OFF';
          let commandObj = {};

          if (typeof command === 'string') {
            // switch command
            state = command;
            commandObj = {
              state: state
            };

            // since the switch doesn't get any updates on whether it's on or not,
            // we fake this by directly send the updateState back to HA in order for
            // it to change state.
            client.updateState(deviceId, {
              state: state === 'ON' ? 1 : 0
            });
          } else {
            state = command.state;
            commandObj = command;
          }

          if (state === 'ON') {
            plejd.turnOn(deviceId, commandObj);
          } else {
            plejd.turnOff(deviceId, commandObj);
          }
        });

        client.on('settingsChanged', (settings) => {
          if (settings.module === 'mqtt') {
            client.updateSettings(settings);
          } else if (settings.module === 'ble') {
            plejd.updateSettings(settings);
          } else if (settings.module === 'api') {
            plejdApi.updateSettings(settings);
          }
        });
      });
    });
  });
}

main();
