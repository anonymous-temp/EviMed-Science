package com.sentum.drugsafe.pojo;

import lombok.Data;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

/***
 * 不良反应
 */
@Data
@Document("zgm_adrs")
public class Adrs {
    @Id
    private String id;
    private String drugName;
    private String description;
    private String chinese;
    private Integer count;
    private String rate;
    private String database;
    private String rr;
    private String or;
    private String ror;
    private String ebgm;
    private String ic;
    private String indicator;
}
