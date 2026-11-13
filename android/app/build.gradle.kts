plugins {
    id("com.android.application")
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

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
