package com.sentum.evidencecomprehensive.domain;

import lombok.Data;
import org.springframework.data.elasticsearch.annotations.Field;
import org.springframework.data.elasticsearch.annotations.FieldType;

@Data
public class RoleCod {
    @Field(type = FieldType.Keyword)
    private  String drug;
    @Field(type = FieldType.Keyword)
    private String role;
    @Field(type = FieldType.Keyword)
    private String prodAi;
}
