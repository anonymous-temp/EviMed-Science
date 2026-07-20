package com.sentum.enums;


public enum MongoTableNameEnum {
    EVIDENCE_C_MESH("evidence_c_mesh", "同义词表"),
    EVIDENCE_MESH("evidence_mesh", "同义词表"),
    //说明书表
    INSTRUCTION("evaluation_assistant_instructions_use", "说明书表"),
     ;



    private String name;

    private String describe;

     MongoTableNameEnum(String name, String describe){
        this.name = name;
        this.describe = describe;
    }

    public String getName(){
        return name;
    }
}
