package com.evimed.agent.evidence.agentevidencebased;

import org.mybatis.spring.annotation.MapperScan;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.cloud.openfeign.EnableFeignClients;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
@EnableFeignClients
@MapperScan("com.evimed.agent.evidence.agentevidencebased.mapper")
public class AgentEvidenceBasedApplication {

    public static void main(String[] args) {
        SpringApplication.run(AgentEvidenceBasedApplication.class, args);
    }

}
