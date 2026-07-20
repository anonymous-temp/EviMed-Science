package com.sentum.pojo.dto;


import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.io.Serializable;

@Data
@NoArgsConstructor
@AllArgsConstructor
public class CacheDto implements Serializable {
    private String key;
    private Object value;
    //描述
    private String description;
}
