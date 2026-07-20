package com.sentum.enums;

import lombok.Getter;

@Getter
public enum ContentTagEnum {

    TXT("text", "文本類型"),
    IMG("img", "图片"),
    LINK("link", "链接"),
    TABLE("table", "表格"),
    ;

    private String type;

    private String describe;

    ContentTagEnum (String type,String describe){
        this.describe = describe;
        this.type = type;
    }
    public static  String ContentTagEnum(String type){
        ContentTagEnum[] contentTagEnums = ContentTagEnum.values();
        for(ContentTagEnum contentTagEnum :contentTagEnums){
            if(contentTagEnum.getType().equals(type)){
                return contentTagEnum.getDescribe();
            }
        }
        return "";
    }
}
