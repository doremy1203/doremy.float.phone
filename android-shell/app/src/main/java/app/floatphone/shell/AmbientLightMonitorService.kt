package app.floatphone.shell

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/** User-opted-in light monitoring for rules such as "dark -> turn on the torch". */
class AmbientLightMonitorService : Service(), SensorEventListener {
    companion object {
        const val ACTION_STOP = "app.floatphone.shell.action.STOP_AMBIENT_LIGHT_MONITOR"
        private const val CHANNEL_ID = "reality_bridge_ambient_light"
        private const val NOTIFICATION_ID = 7324
        private const val DARK_LUX = 15f
        private const val RECOVER_LUX = 24f
    }

    private var sensorManager: SensorManager? = null
    private var lightSensor: Sensor? = null
    private var darkLatched = false

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, buildNotification())
        sensorManager = getSystemService(SENSOR_SERVICE) as? SensorManager
        lightSensor = sensorManager?.getDefaultSensor(Sensor.TYPE_LIGHT)
        if (lightSensor == null) {
            NativeRealityBridge.capture(this, "环境光线感知不可用", "此设备没有可用的环境光线传感器")
            stopSelf()
            return
        }
        sensorManager?.registerListener(this, lightSensor, SensorManager.SENSOR_DELAY_NORMAL)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            sensorManager?.unregisterListener(this)
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        return START_STICKY
    }

    override fun onSensorChanged(event: SensorEvent?) {
        val lux = event?.values?.firstOrNull() ?: return
        if (!lux.isFinite()) return
        if (lux <= DARK_LUX && !darkLatched) {
            darkLatched = true
            NativeRealityBridge.capture(this, "环境光线", "环境很暗；光照 " + lux.toInt() + " lux；很暗")
        } else if (lux >= RECOVER_LUX) {
            darkLatched = false
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

    override fun onDestroy() {
        sensorManager?.unregisterListener(this)
        sensorManager = null
        lightSensor = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(NotificationChannel(
                CHANNEL_ID, "现实桥 · 环境光线自动化", NotificationManager.IMPORTANCE_LOW
            ).apply { description = "启用环境光线设备动作规则后持续监测照度。" })
        }
    }

    private fun buildNotification(): Notification {
        val openApp = PendingIntent.getActivity(this, 7325,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 7326,
            Intent(this, AmbientLightMonitorService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_manage)
            .setContentTitle("现实桥正在监测环境光线")
            .setContentText("已启用暗光自动化规则。点“停止监测”可关闭传感器服务。")
            .setContentIntent(openApp)
            .addAction(0, "停止监测", stop)
            .setOngoing(true)
            .build()
    }
}