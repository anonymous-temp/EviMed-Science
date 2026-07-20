package com.sentum.evidencecomprehensive.pojo.bo.mongo;

import lombok.Data;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;

import java.util.Objects;

/***
 * 不良反应
 */
@Data
@Document("zgm_adrs")
public class Adrs {
    @Id
    private String id;
    private String drugName;
    @Field("description")
    private String en;
    @Field("chinese")
    private String zh;

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (o == null || getClass() != o.getClass()) return false;
        Adrs adrs = (Adrs) o;
        return Objects.equals(en, adrs.en);
    }

    @Override
    public int hashCode() {
        return Objects.hash(en);
    }

    @Field("count")
    private Integer num;
    private String rate;
    private String database;
    private String rr;
    private String or;
    private String ror;
    private String ebgm;
    private String ic;
    private String indicator;
    private String soc;
}
