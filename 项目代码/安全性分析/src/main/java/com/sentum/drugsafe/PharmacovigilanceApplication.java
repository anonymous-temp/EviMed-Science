package com.sentum.drugsafe;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.cloud.netflix.eureka.EnableEurekaClient;
import org.springframework.cloud.openfeign.EnableFeignClients;
import org.springframework.kafka.annotation.EnableKafka;
import org.springframework.scheduling.annotation.EnableAsync;

@EnableFeignClients
@EnableEurekaClient
@SpringBootApplication
@EnableKafka
@EnableAsync
public class PharmacovigilanceApplication {

    public static void main(String[] args) {
        SpringApplication.run(PharmacovigilanceApplication.class, args);
    }

}
