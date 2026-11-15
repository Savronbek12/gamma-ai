import java.util.Properties

plugins {
    id("com.android.application")
}

// Imzolash kaliti ma'lumotlari keystore.properties faylida (git'ga yuklanmaydi)
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "uz.gammaai.app"
    compileSdk = 37

    defaultConfig {
        applicationId = "uz.gammaai.app"
        minSdk = 24
        targetSdk = 37
        versionCode = 1
        versionName = "1.0"
        // Ilova ochadigan sayt manzili (domen tayyor bo'lganda shu yerni o'zgartiring)
        buildConfigField("String", "SITE_URL", "\"https://gamma-ai-03tm.onrender.com/\"")
    }

    signingConfigs {
        if (keystoreProps.containsKey("storeFile")) {
            create("release") {
                storeFile = file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
            signingConfigs.findByName("release")?.let { signingConfig = it }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
