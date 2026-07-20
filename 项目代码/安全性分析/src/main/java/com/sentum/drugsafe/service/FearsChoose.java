package com.sentum.drugsafe.service;

import org.springframework.stereotype.Service;

@Service
public interface FearsChoose {

    void getDrug(String databaseName);

    void getDemo(String databaseName);

    void getPt(String databaseName);

}
